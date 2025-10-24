// serverside.js
const express = require('express');
const bodyParser = require('body-parser'); 
const { MongoClient, ObjectId } = require('mongodb');
const { v4: uuidv4 } = require('uuid'); 
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const Razorpay = require('razorpay'); 
// NEW: Import the crypto module for signature verification
const crypto = require('crypto'); // Built-in Node.js module

// IMPORTANT: dotenv is NOT used as per your request.
// This means sensitive information will be directly embedded below.
// For production, it is HIGHLY recommended to use environment variables.

//const app = express();
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const app = express();
// Use process.env to access environment variables.
const port = process.env.PORT || 8084;
const mongoURI = process.env.MONGO_URI;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CX = process.env.GOOGLE_CX;  
// NEW: Razorpay Keys
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

// NEW: Initialize Razorpay instance
const razorpay = new Razorpay({
    key_id: RAZORPAY_KEY_ID,
    key_secret: RAZORPAY_KEY_SECRET,
});

let client;
let db;

/**
 * Establishes a connection to the MongoDB database.
 * If connection fails, the application will exit.
 */
async function connectDB() {
    try {
        client = new MongoClient(mongoURI); // Create new client instance
        await client.connect(); // Connect the client
        console.log("Connected to MongoDB");
        db = client.db('godb'); // Your database name (should match DB_NAME if set)
    } catch (err) {
        console.error("Error connecting to MongoDB:", err);
        console.error("Application will exit due to database connection failure.");
        process.exit(1); // Exit if DB connection fails
    }
}

/**
 * Ensures unique index for userId in 'users' collection and foodId in 'feedbacks' collection.
 */
async function createIndexes() {
    try {
        // The _id field is automatically indexed and unique in MongoDB,
        // so explicitly creating an index on _id with { unique: true } is unnecessary and causes the reported error.
        // Removed: await db.collection('users').createIndex({ _id: 1 }, { unique: true });
        console.log("Note: _id index on 'users' collection is automatically handled by MongoDB.");

        // Index for feedbacks collection (foodId)
        await db.collection('feedbacks').createIndex({ foodId: 1 });
        console.log("Index on feedbacks.foodId created successfully.");
    } catch (error) {
        console.error("Error creating indexes:", error);
    }
}

// --- Helper Functions (Server-Side Calculation Logic) ---

const unitConversionFactors = {
    'kg': 1,
    'litre': 1,
    'gm': 0.001, // 1 gram = 0.001 kg
    'ml': 0.001 // 1 ml = 0.001 litre
};

// Function to parse "buy N get M free" text
function parseBuyNGetMFree(text) {
    if (!text || typeof text !== 'string') return null;
    const match = text.toLowerCase().match(/buy (\d+) get (\d+)(?: (\w+))?/);
    if (match) {
        return {
            buyQuantity: parseInt(match[1]),
            getQuantity: parseInt(match[2]),
            unit: match[3] ? match[3].toLowerCase() : null // 'kg', 'piece', 'litre' or null if not specified
        };
    }
    return null;
}

/**
 * Helper function to calculate a price increment based on defined price ranges.
 * This mirrors the frontend logic for range-based pricing.
 * @param {number} originalPrice - The original price of the item.
 * @returns {number} The calculated price increment based on ranges.
 */
function calculatePriceIncrementBasedOnRange(originalPrice) {
            let initialIncrement = 0;

    // Step 1: Determine the base increment based on the price range
    if (originalPrice === 0) {
        initialIncrement = 0;
    } else if (originalPrice >= 1 && originalPrice <= 5) {
        initialIncrement = 1;
    } else if (originalPrice >= 6 && originalPrice <= 10) {
        initialIncrement = 2;
    } else if (originalPrice >= 11 && originalPrice <= 30) {
        initialIncrement = 3;
    } else if (originalPrice >= 31 && originalPrice <= 60) {
        initialIncrement = 5;
    } else if (originalPrice >= 61 && originalPrice <= 90) {
        initialIncrement = 7;
    } else if (originalPrice >= 91) {
        // For prices 91 and above, the increment increases by 2 for every 30-unit increase
        initialIncrement = 7 + Math.ceil((originalPrice - 90) / 30) * 2;
    }

    // Step 2: Calculate the price after the first increment to use for the second increment calculation
    let newPrice = originalPrice + initialIncrement;

    // Step 3: Calculate the additional 3% increment
    let moreIncrement = newPrice * 0.03;

    // Step 4: Sum both increments to get the total increment
    let increment = initialIncrement + moreIncrement;

    return increment;
        }

/**
 * Helper function to calculate the price increment for subscribed users.
 * @param {number} originalPrice - The base price of the item.
 * @returns {number} The increment amount based on the subscription rules.
 */
function calculateSubscriptionPriceIncrement(originalPrice) {
    let increment = 0;
    if (originalPrice >= 0 && originalPrice <= 30) {
        increment = 3;
    } else if (originalPrice > 30 && originalPrice <= 60) {
        increment = 5;
    } else if (originalPrice > 60 && originalPrice <= 90) {
        increment = 7;
    } else if (originalPrice > 90 && originalPrice <= 120) {
        increment = 9;
    } else if (originalPrice > 120) {
        increment = 9; // Base increment for >120
        const diff = originalPrice - 120;
        // For every 30 difference, add an additional 2
        const intervals = Math.floor(diff / 30); // Use floor as per "every 30 range" meaning after 120, next 30, then next 30.
        increment += intervals * 2;
    }
    return increment;
}

/**
 * Server-side calculation of item price and effective quantity, including discount and unit conversion.
 * MODIFIED: Added hasSubscribed and subscriptionExpiryDate parameters.
 * @param {Object} itemData - The raw food item document from the 'foods' collection.
 * @param {number} requestedQuantity - The quantity requested by the customer (e.g., 6 for "buy 5 get 1 free").
 * @param {string} requestedUnit - The unit requested by the customer (e.g., 'kg', 'piece').
 * @param {boolean} hasSubscribed - Whether the shop owner has an active subscription.
 * @param {Date|null} subscriptionExpiryDate - The subscription expiry date for the shop owner.
 * @returns {Object} An object containing price per unit, subtotal, and effective quantity charged.
 */
function calculateItemPriceServer(itemData, requestedQuantity, requestedUnit, hasSubscribed, subscriptionExpiryDate) {
    // Ensure itemData.price is a number, default to 0 if null/undefined
    let effectivePrice = typeof itemData.price === 'number' ? itemData.price : 0;

    // 1. Apply the new price increment based on range (NEW ADDITION)
    const rangeIncrement = calculatePriceIncrementBasedOnRange(effectivePrice);
    if (rangeIncrement > 0) {
        effectivePrice += rangeIncrement;
        console.log(`Server: Applied range increment of ${rangeIncrement} to ${itemData.food}. New effective price after range: ${effectivePrice.toFixed(2)}`);
    }

    // 2. Apply subscription price increment if applicable and subscription is active
    const today = new Date();
    let subscriptionApplied = false; // Flag to track if subscription increment was applied
    if (hasSubscribed && subscriptionExpiryDate && today < new Date(subscriptionExpiryDate)) {
        const subscriptionIncrement = calculateSubscriptionPriceIncrement(effectivePrice); // Use effectivePrice here
        if (subscriptionIncrement > 0) {
            effectivePrice += subscriptionIncrement;
            subscriptionApplied = true; // Set the flag to true
        }
        console.log(`Server: Applied subscription increment of ${subscriptionIncrement} to ${itemData.food}. New effective price after subscription: ${effectivePrice.toFixed(2)}`);
    }

    let effectiveQuantityForPricing = requestedQuantity;

    // 3. Handle unit conversions (logic from original calculateItemPriceServer)
    let basePriceUnit = itemData.unit || itemData.weightUnit;
    if (requestedUnit && basePriceUnit && requestedUnit.toLowerCase() !== basePriceUnit.toLowerCase()) {
        const conversionFactor = unitConversionFactors[requestedUnit.toLowerCase()];
        // Check for specific conversions (e.g., gm to kg, ml to litre)
        if (conversionFactor !== undefined && ((basePriceUnit.toLowerCase() === 'kg' && requestedUnit.toLowerCase() === 'gm') || (basePriceUnit.toLowerCase() === 'litre' && requestedUnit.toLowerCase() === 'ml'))) {
            effectiveQuantityForPricing = requestedQuantity * conversionFactor;
        } else if (conversionFactor !== undefined) { // Generic conversion for other units if needed
            effectiveQuantityForPricing = requestedQuantity * conversionFactor;
        }
    }

    // 4. Apply "buy N get M free" discount to calculate effective quantity for pricing
    if (itemData.discountType === 'other' && itemData.otherDiscountText) {
        const buyNGetMFreeDetails = parseBuyNGetMFree(itemData.otherDiscountText);
        if (buyNGetMFreeDetails) {
            const { buyQuantity, getQuantity, unit: discountUnit } = buyNGetMFreeDetails;
            let quantityForDiscountCalculation = requestedQuantity;
            if (discountUnit && requestedUnit && discountUnit.toLowerCase() !== requestedUnit.toLowerCase()) {
                const reqToDiscConversion = unitConversionFactors[requestedUnit.toLowerCase()] / unitConversionFactors[discountUnit.toLowerCase()];
                if (!isNaN(reqToDiscConversion) && reqToDiscConversion > 0) {
                    quantityForDiscountCalculation = quantityForDiscountCalculation * reqToDiscConversion;
                }
            }
            if (buyQuantity > 0 && quantityForDiscountCalculation >= buyQuantity) {
                const numSets = Math.floor(quantityForDiscountCalculation / buyQuantity);
                const freeUnits = numSets * getQuantity;
                effectiveQuantityForPricing = requestedQuantity - freeUnits;
                if (effectiveQuantityForPricing < 0) effectiveQuantityForPricing = 0; // Cannot charge for negative quantity
                console.log(`Server: Applied 'buy ${buyQuantity} get ${getQuantity} free' discount. Original requested quantity: ${requestedQuantity}, Calculated quantity for pricing: ${effectiveQuantityForPricing}`);
            }
        }
    }

    // 5. Apply percentage or flat discount to the calculated effectivePrice (after subscription increment)
    if (itemData.discountType === '%' && typeof itemData.discountValue === 'number' && itemData.discountValue !== null) {
        effectivePrice = effectivePrice * (1 - itemData.discountValue / 100); // Corrected from item.discountValue
    } else if (itemData.discountType === 'flat' && typeof itemData.discountValue === 'number' && itemData.discountValue !== null) {
        effectivePrice = effectivePrice - itemData.discountValue; // Corrected from item.discountValue
        if (effectivePrice < 0) effectivePrice = 0;
    }

    const subtotal = effectiveQuantityForPricing * effectivePrice;
    return {
        pricePerUnit: parseFloat(effectivePrice.toFixed(2)), // This is the final effective price per unit after all calculations
        subtotal: parseFloat(subtotal.toFixed(2)),
        effectiveQuantityCharged: parseFloat(effectiveQuantityForPricing.toFixed(3)), // Store with precision for units like gm/ml
        subscriptionApplied: subscriptionApplied // Return the flag
    };
}


// Immediately invoked async function to connect to DB and start the server
(async () => {
    await connectDB(); // Connect to DB when server starts
    await createIndexes(); // Create indexes after connecting

    // --- Middleware ---
    // Enable CORS for all routes to allow cross-origin requests
    app.use(cors());
    // Parse JSON request bodies
    app.use(bodyParser.json()); // NOTE: bodyParser is deprecated, express.json() is preferred for newer Express versions.

    // Serve static files from the root directory of the server.
    // Adjust `path.join(__dirname, '')` if your HTML/frontend files are in a specific subfolder (e.g., 'public', 'customer').
    app.use(express.static(path.join(__dirname, '')));

    // NEW: Endpoint to serve the AR view page
    // This route is more specific and should be placed before the general '/customer/order/:userId/:storeName' route
    app.get('/customer/order/:userId/:storeName/ar-view.html', async (req, res) => {
        const userIdFromUrl = req.params.userId;
        const storeNameFromUrl = decodeURIComponent(req.params.storeName);
        const itemId = req.query.itemid; // itemId is a query parameter, not a URL parameter here.

        console.log(`[/customer/order/:userId/:storeName/ar-view.html] Route accessed for userId: ${userIdFromUrl}, storeName: ${storeNameFromUrl}, itemId: ${itemId}`);

        try {
            if (!ObjectId.isValid(userIdFromUrl)) {
                console.error(`Invalid User ID format received: ${userIdFromUrl}`);
                return res.status(400).send('Invalid User ID format in URL.');
            }

            // Verify if the userId and storeName exist as a valid user/shop in the 'users' collection
            const user = await db.collection('users').findOne({
                _id: new ObjectId(userIdFromUrl),
                storename: storeNameFromUrl
            });

            if (user) {
                console.log(`[/customer/order/:userId/:storeName/ar-view.html] Association found for user: ${user.username}. Serving AR webpage.`);
                res.sendFile(path.join(__dirname, 'ar-view.html')); // Serve the ar-view.html file
            } else {
                console.log(`[/customer/order/:userId/:storeName/ar-view.html] Association not found for userId: ${userIdFromUrl}, storeName: ${storeNameFromUrl}.`);
                res.status(404).send('Store not found or invalid association for this user.');
            }
        } catch (error) {
            console.error("[/customer/order/:userId/:storeName/ar-view.html] Error checking association:", error);
            res.status(500).send('Internal Server Error while verifying store.');
        }
    });

    /**
     * Endpoint to serve the customer ordering page.
     * Verifies if the userId and storeName exist as a valid user/shop.
     * @param {string} req.params.userId - The ID of the shoper.
     * @param {string} req.params.storeName - The store name of the shoper.
     */
    app.get('/customer/order/:userId/:storeName', async (req, res) => {
        const userIdFromUrl = req.params.userId;
        const storeNameFromUrl = decodeURIComponent(req.params.storeName); // Decode URL-encoded store name
        console.log(`[/customer/order/:userId/:storeName] Route accessed for userId: ${userIdFromUrl}, storeName: ${storeNameFromUrl}`);

        try {
            // Validate if the userId is a valid MongoDB ObjectId
            if (!ObjectId.isValid(userIdFromUrl)) {
                console.error(`Invalid User ID format received: ${userIdFromUrl}`);
                return res.status(400).send('Invalid User ID format in URL.');
            }

            // Verify if the userId and storeName exist as a valid user/shop in the 'users' collection
            const user = await db.collection('users').findOne({
                _id: new ObjectId(userIdFromUrl),
                storename: storeNameFromUrl
            });

            if (user) {
                console.log(`[/customer/order/:userId/:storeName] Association found for user: ${user.username}. Serving webpage.`);
                // Serve the food-ordering-app.html file if the association is valid
                res.sendFile(path.join(__dirname, 'index.html'));
            } else {
                console.log(`[/customer/order/:userId/:storeName] Association not found for userId: ${userIdFromUrl}, storeName: ${storeNameFromUrl}.`);
                res.status(404).send('Store not found or invalid association for this user.');
            }
        } catch (error) {
            console.error("[/customer/order/:userId/:storeName] Error checking association:", error);
            res.status(500).send('Internal Server Error while verifying store.');
        }
    });

    /**
     * Endpoint to get food items for a specific user (shoper) with feedback and average rating.
     * MODIFIED: To include discount fields and ensure feedback/average rating are correctly calculated.
     * Now also includes shop owner's subscription status for pricing.
     * @param {string} req.query.userId - The ID of the shoper whose food items are to be fetched.
     */
    app.get('/foodItems', async (req, res) => {
        const userId = req.query.userId;
        console.log('[/foodItems] Route accessed. Received userId:', userId);

        if (!userId) {
            return res.status(400).json({ error: 'User ID (of the shoper) is required to fetch food items.' });
        }

        try {
            if (!ObjectId.isValid(userId)) {
                console.error(`Invalid User ID format received for /foodItems: ${userId}`);
                return res.status(400).json({ error: 'Invalid User ID format.' });
            }

            // Fetch user details to determine subscription status
            const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
            if (!user) {
                return res.status(404).json({ error: 'Shop owner user not found.' });
            }
            const hasSubscribed = user.hasSubscribed || false;
            const subscriptionExpiryDate = user.subscriptionExpiryDate ? new Date(user.subscriptionExpiryDate) : null;
            console.log(`[/foodItems] Shop owner subscription status: hasSubscribed=${hasSubscribed}, subscriptionExpiryDate=${subscriptionExpiryDate}`);


            const query = { userId: new ObjectId(userId) };
            const foodItems = await db.collection('foods').find(query).toArray();
            console.log(`[/foodItems] Found ${foodItems.length} food items for userId: ${userId}`);

            const formattedItems = [];
            // Iterate through each food item to fetch its feedback and calculate average rating
            for (const item of foodItems) {
                // Fetch all feedbacks for a food item, sorted by latest first
                const allFeedbacks = await db.collection('feedbacks')
                    .find({ foodId: item._id })
                    .sort({ createdAt: -1 })
                    .toArray();

                let averageRating = 0;
                // Filter out feedbacks without a valid rating and map to an array of ratings
                const ratings = allFeedbacks.filter(fb => fb.rating !== null && fb.rating !== undefined).map(fb => fb.rating);

                if (ratings.length > 0) {
                    const totalRating = ratings.reduce((sum, r) => sum + r, 0);
                    averageRating = (totalRating / ratings.length).toFixed(1); // Calculate average, one decimal place
                }

                // Calculate the displayed price including subscription increment and discounts for the frontend
                // Using a dummy quantity of 1 and item's base unit to get the 'pricePerUnit' for display.
                const { pricePerUnit: displayedPriceAfterSubscriptionAndDiscount } = calculateItemPriceServer(
                    item, 1, item.unit || item.weightUnit || 'piece', hasSubscribed, subscriptionExpiryDate
                );

                // Push the formatted item with its details, average rating, and all feedbacks
                formattedItems.push({
                    _id: item._id.toString(),
                    name: item.food, // Assuming 'food' field is the item name
                    price: item.price, // Original base price from DB
                    displayedPrice: displayedPriceAfterSubscriptionAndDiscount, // NEW: Price after subscription increment and discounts
                    category: item.category,
                    mainCategory: item.mainCategory || 'N/A', // Include mainCategory
                    description: item.description || '', // Include description, default to empty string
                    unit: item.unit || '',            // Include unit, default to empty string
                    weightUnit: item.weightUnit || '',  // Include weightUnit, default to empty string
                    imageUrl: item.imageUrl || null,
                    imageData: item.imageData || null, // Include imageData
                    __v: item.__v, // Include __v if it exists (from Mongoose-like data, though native driver doesn't add by default)
                    averageRating: parseFloat(averageRating), // Store as number
                    feedbacks: allFeedbacks.map(fb => ({
                        customerName: fb.customerName,
                        rating: fb.rating,
                        comment: fb.comment,
                        liked: fb.liked,
                        createdAt: fb.createdAt
                    })),
                    // NEW: Include discount details from the 'foods' collection
                    discountType: item.discountType || null,
                    discountValue: item.discountValue || null,
                    otherDiscountText: item.otherDiscountText || null,
                    tags: item.tags || [], // NEW: Include tags from the 'foods' collection
                    estimatedTime: item.estimatedTime || 0, // NEW: Include estimatedTime from food item
                    estimatedTimeUnit: item.estimatedTimeUnit || 'minutes' // NEW: Include estimatedTimeUnit from food item
                });
            }

            console.log('[/foodItems] Successfully formatted foodItems with feedback and average rating.');
            res.status(200).json(formattedItems);
        } catch (err) {
            console.error('[/foodItems] Error fetching food items with feedback:', err);
            res.status(500).json({ error: "Failed to fetch food items", details: err.message });
        }
    });

    /**
     * Endpoint to get user details (including UPI ID and QR image data).
     * MODIFIED: To ensure UPI ID and imageData (QR code) are fetched and sent.
     * Also sends hasSubscribed and subscriptionExpiryDate.
     * @param {string} req.query.userId - The ID of the user whose details are to be fetched.
     */
    app.get('/userDetails', async (req, res) => {
        const userId = req.query.userId;
        console.log('[/userDetails] Route accessed. Received userId:', userId);

        if (!userId) {
            return res.status(400).json({ error: 'User ID is required to fetch user details.' });
        }

        try {
            // Validate if the userId is a valid MongoDB ObjectId
            if (!ObjectId.isValid(userId)) {
                console.error(`Invalid User ID format received for /userDetails: ${userId}`);
                return res.status(400).json({ error: 'Invalid User ID format.' });
            }

            // Find the user in the 'users' collection
            const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });

            if (user) {
                // Prioritize 'upiId' field, then fallback to 'merchantDetails' for UPI ID
                const userUpiId = user.upiId || user.merchantDetails || null;

                // Construct the user details object
                const userDetails = {
                    _id: user._id.toString(),
                    username: user.username,
                    storename: user.storename,
                    contact: user.contact,
                    email: user.email,
                    address: user.address,
                    city: user.city,
                    locality: user.locality,
                    country: user.country,
                    state: user.state,
                    upiId: userUpiId, // Now includes UPI ID from either field
                    // imageData is stored as a direct base64 data URL string in MongoDB
                    // The frontend is now updated to directly use this string.
                    imageData: user.imageData || null, 
                    hasSubscribed: user.hasSubscribed || false, // NEW: Include subscription status
                    subscriptionExpiryDate: user.subscriptionExpiryDate ? new Date(user.subscriptionExpiryDate) : null // NEW: Include subscription expiry date
                };
                console.log('[/userDetails] User details fetched successfully for userId:', userId, 'UPI ID:', userUpiId);
                res.status(200).json(userDetails);
            } else {
                console.log('[/userDetails] User not found for userId:', userId);
                res.status(404).json({ error: 'User not found.' });
            }
        } catch (err) {
            console.error('[/userDetails] Error fetching user details:', err);
            res.status(500).json({ error: 'Failed to fetch user details.', details: err.message });
        }
    });

    /**
     * MODIFIED: Endpoint to get shop-specific instructions.
     * This endpoint fetches general instructions for a shop, such as "no exchange" policies.
     * It now ensures the response is always an array of structured instruction objects.
     * @param {string} req.query.userId - The ID of the shoper whose instructions are to be fetched.
     */
    app.get('/instructions', async (req, res) => { // Changed endpoint to /instructions
        const userId = req.query.userId;
        console.log('[/instructions] Route accessed. Received userId:', userId);

        if (!userId) {
            return res.status(400).json({ error: 'User ID is required to fetch shop instructions.' });
        }

        try {
            if (!ObjectId.isValid(userId)) {
                console.error(`Invalid User ID format received for /instructions: ${userId}`);
                return res.status(400).json({ error: 'Invalid User ID format.' });
            }

            // Fetch instructions from the 'instructions' collection.
            const rawInstructions = await db.collection('instructions').find({ userId: new ObjectId(userId) }).toArray(); // Changed collection name

            let formattedInstructions = [];

            if (rawInstructions.length > 0) {
                // Iterate through each document found
                rawInstructions.forEach(doc => {
                    if (doc.type && doc.instructionText) {
                        // If it's already in the desired structured format
                        formattedInstructions.push({
                            type: doc.type,
                            instructionText: doc.instructionText
                        });
                    } else if (typeof doc.instructions === 'string') {
                        // If it's a simple string in an 'instructions' field
                        // Assign a default type, e.g., 'generalPolicy'
                        formattedInstructions.push({
                            type: 'generalPolicy',
                            instructionText: doc.instructions
                        });
                    }
                    // Add more else if conditions here if there are other instruction formats
                });
                console.log(`[/instructions] Found and formatted ${formattedInstructions.length} instructions for userId: ${userId}`);
                res.status(200).json(formattedInstructions);
            } else {
                console.log(`[/instructions] No instructions found for userId: ${userId}. Returning empty array.`);
                res.status(200).json([]); // Return an empty array if no instructions are found
            }
        } catch (err) {
            console.error('[/instructions] Error fetching shop instructions:', err);
            res.status(500).json({ error: 'Failed to fetch shop instructions.', details: err.message });
        }
    });


    /**
     * Endpoint to update a user's UPI ID.
     * @param {string} req.body.userId - The ID of the user to update.
     * @param {string} req.body.upiId - The new UPI ID.
     */
    app.put('/updateUpiId', async (req, res) => {
        const { userId, upiId } = req.body;
        console.log('[/updateUpiId] Received request to update UPI ID for userId:', userId, 'with UPI ID:', upiId);

        if (!userId || !upiId) {
            return res.status(400).json({ error: 'User ID and UPI ID are required.' });
        }

        try {
            // Validate if the userId is a valid MongoDB ObjectId
            if (!ObjectId.isValid(userId)) {
                console.error(`Invalid User ID format received for /updateUpiId: ${userId}`);
                return res.status(400).json({ error: 'Invalid User ID format.' });
            }

            // Update the 'upiId' field for the specified user in the 'users' collection
            const result = await db.collection('users').updateOne(
                { _id: new ObjectId(userId) },
                { $set: { upiId: upiId } }
            );

            if (result.matchedCount === 0) {
                console.log('[/updateUpiId] User not found for userId:', userId);
                return res.status(404).json({ error: 'User not found.' });
            }

            console.log('[/updateUpiId] UPI ID updated successfully for userId:', userId);
            res.status(200).json({ success: true, message: 'UPI ID updated successfully.' });

        } catch (err) {
            console.error('[/updateUpiId] Error updating UPI ID:', err);
            res.status(500).json({ error: 'Failed to update UPI ID.', details: err.message });
        }
    });
    /**
     * Endpoint to submit feedback for a food item.
     * @param {string} req.params.itemId - The ID of the food item from the URL.
     * @param {string} req.body.userId - The ID of the shoper (owner of the food item).
     * @param {string} req.body.customerName - The name of the customer submitting feedback.
     * @param {number} [req.body.rating] - The rating (1-5).
     * @param {string} [req.body.comment] - The feedback comment.
     * @param {boolean} [req.body.liked] - Whether the item was liked.
     */
    app.post('/foodItems/:itemId/feedback', async (req, res) => {
        const { userId, customerName, rating, comment, liked } = req.body;
        const { itemId } = req.params; // GET ITEM ID FROM URL PARAMETERS
        console.log('[/foodItems/:itemId/feedback] Received feedback for itemId:', itemId, 'Data:', req.body);

        // Basic validation for essential fields
        if (!comment && (rating === undefined || rating === null) && (liked === undefined || liked === null || liked === false)) {
            console.error(`Feedback submission without comment, rating, or liked status for itemId: ${itemId}`);
            return res.status(400).json({ error: 'At least one of comment, rating, or liked status is required for feedback.' });
        }

        // Validate rating if provided
        if (rating !== undefined && rating !== null && (isNaN(rating) || rating < 1 || rating > 5)) {
            console.error(`Invalid rating value received for itemId: ${itemId}, rating: ${rating}`);
            return res.status(400).json({ error: 'Rating must be a number between 1 and 5.' });
        }

        try {
            // Validate if itemId and userId are valid MongoDB ObjectIds
            if (!ObjectId.isValid(itemId) || !ObjectId.isValid(userId)) {
                console.error(`Invalid Food ID or User ID format for feedback: ItemId=${itemId}, UserId=${userId}`);
                return res.status(400).json({ error: 'Invalid Food ID or User ID format.' });
            }

            // Create a new feedback document
            const newFeedback = {
                foodId: new ObjectId(itemId),    // Store as foodId in feedback collection
                userId: new ObjectId(userId),    // This is the shoper's userId
                customerName: customerName,      // This is the customer's name
                rating: rating ? parseInt(rating) : null, // Store rating as number, can be null
                comment: comment || '',          // Ensure comment is a string, even if empty
                liked: typeof liked === 'boolean' ? liked : false, // Ensure liked is a boolean
                createdAt: new Date()            // Timestamp for when feedback was created
            };

            // Insert the new feedback into the 'feedbacks' collection
            const result = await db.collection('feedbacks').insertOne(newFeedback);
            console.log('[/foodItems/:itemId/feedback] Feedback inserted with ID:', result.insertedId);

            // After successfully saving feedback, retrieve the updated food item
            // and include all its feedback and the newly calculated average rating
            const foodItemAfterFeedback = await db.collection('foods').findOne({ _id: new ObjectId(itemId) });

            if (foodItemAfterFeedback) {
                // Fetch all feedbacks for this food item to re-calculate average rating and send them back
                const allFeedbacksForFood = await db.collection('feedbacks')
                    .find({ foodId: new ObjectId(itemId) })
                    .sort({ createdAt: -1 }) // Sort by latest feedback first
                    .toArray();

                let newAverageRating = 0;
                const ratingsForAvg = allFeedbacksForFood.filter(fb => fb.rating !== null && fb.rating !== undefined).map(fb => fb.rating);

                if (ratingsForAvg.length > 0) {
                    const totalRatingForAvg = ratingsForAvg.reduce((sum, r) => sum + r, 0);
                    newAverageRating = (totalRatingForAvg / ratingsForAvg.length).toFixed(1);
                }
                // Fetch user details for subscription status to correctly format the updated item's price
                const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
                const hasSubscribed = user ? (user.hasSubscribed || false) : false;
                const subscriptionExpiryDate = user ? (user.subscriptionExpiryDate ? new Date(user.subscriptionExpiryDate) : null) : null;


                // Calculate the displayed price including subscription increment and discounts
                const { pricePerUnit: displayedPriceAfterSubscriptionAndDiscount } = calculateItemPriceServer(
                    foodItemAfterFeedback, 1, foodItemAfterFeedback.unit || foodItemAfterFeedback.weightUnit || 'piece', hasSubscribed, subscriptionExpiryDate
                );
                // Format the updated food item to match the frontend's expected structure
                const formattedUpdatedItem = {
                    _id: foodItemAfterFeedback._id.toString(),
                    name: foodItemAfterFeedback.food, // Assuming 'food' field is the item name
                    price: foodItemAfterFeedback.price, // Original base price from DB
                    displayedPrice: displayedPriceAfterSubscriptionAndDiscount, // NEW: Price after subscription increment and discounts
                    category: foodItemAfterFeedback.category,
                    description: foodItemAfterFeedback.description || '',
                    unit: foodItemAfterFeedback.unit || '',
                    weightUnit: foodItemAfterFeedback.weightUnit || '',
                    imageUrl: foodItemAfterFeedback.imageUrl || null,
                    imageData: foodItemAfterFeedback.imageData || null, // Include imageData
                    __v: foodItemAfterFeedback.__v, // Include __v if it exists
                    averageRating: parseFloat(newAverageRating), // Store as number
                    feedbacks: allFeedbacksForFood.map(fb => ({
                        customerName: fb.customerName,
                        rating: fb.rating,
                        comment: fb.comment,
                        liked: fb.liked,
                        createdAt: fb.createdAt // Include createdAt for sorting/display
                    })),
                    // NEW: Include discount details
                    discountType: foodItemAfterFeedback.discountType || null,
                    discountValue: foodItemAfterFeedback.discountValue || null,
                    otherDiscountText: foodItemAfterFeedback.otherDiscountText || null,
                    tags: foodItemAfterFeedback.tags || [], // NEW: Include tags
                    estimatedTime: foodItemAfterFeedback.estimatedTime || 0, // Include estimatedTime from food item
                    estimatedTimeUnit: foodItemAfterFeedback.estimatedTimeUnit || 'minutes' // Include estimatedTimeUnit from food item
                };
                console.log('[/foodItems/:itemId/feedback] Sending back updated food item:', formattedUpdatedItem._id);
                res.status(201).json(formattedUpdatedItem); // Send back the complete updated item
            } else {
                // Fallback: If for some reason the food item itself isn't found after feedback,
                // still send a success message. This scenario should be rare if itemId is valid.
                console.warn('[/foodItems/:itemId/feedback] Feedback submitted, but food item not found for re-fetching. ItemId:', itemId);
                res.status(201).json({ success: true, message: 'Feedback submitted successfully, but could not retrieve updated item details.', newAverageRating: parseFloat(newAverageRating) });
            }
        } catch (err) {
            console.error('[/foodItems/:itemId/feedback] Error submitting feedback:', err);
            res.status(500).json({ error: 'Failed to submit feedback.', details: err.message });
        }
    });

    /**
     * Endpoint to search for images using Google Custom Search API.
     * @param {string} req.query.query - The search query for the image.
     */
    app.get('/searchImage', async (req, res) => {
        const query = req.query.query;
        console.log(`[/searchImage] Received query: "${query}"`);

        if (!query) {
            return res.status(400).json({ error: 'Query parameter is required for image search.' });
        }

        // Check if API keys are still placeholder values - CRITICAL WARNING
        if (GOOGLE_API_KEY === "YOUR_ACTUAL_GOOGLE_API_KEY_HERE" || GOOGLE_CX === "YOUR_ACTUAL_GOOGLE_CX_HERE") {
            console.warn('Google API Key or CX is still set to placeholder values in server.js. Please update them. Using a placeholder image.');
            return res.json({ imageUrl: 'https://placehold.co/150?text=Set+API+Keys' });
        }

        try {
            // Construct the Google Custom Search API URL for image search
            const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(query)}&searchType=image&num=1`;
            console.log(`[/searchImage] Fetching from Google Custom Search: ${searchUrl}`);

            // Make the API call using axios
            const response = await axios.get(searchUrl);
            const items = response.data.items;

            if (items && items.length > 0) {
                console.log(`[/searchImage] Found image: ${items[0].link}`);
                res.json({ imageUrl: items[0].link }); // Return the URL of the first image found
            } else {
                console.log(`[/searchImage] No image found for query: "${query}".`);
                res.json({ imageUrl: 'https://placehold.co/100?text=No+Image+Found' }); // Return a placeholder if no image is found
            }
        } catch (error) {
            console.error('[/searchImage] Error in image search:', error.message);
            if (error.response) {
                console.error('Google API Response Error:', error.response.status, error.response.data);
            }
            res.status(500).json({ error: 'Failed to search for image.', details: error.message });
        }
    });

    // ----------------------------------------------------------------------
    // OLD RAZORPAY INTEGRATION ENDPOINT (Now deprecated/removed from the client side)
    // ----------------------------------------------------------------------

    /**
     * OLD: Endpoint to create a Razorpay Order ID.
     * Replaced by the logic within /api/place-order
     */
    app.post('/createOrder', async (req, res) => {
        const { amount, receiptId } = req.body;
        console.log('[/createOrder] Received request to create Razorpay order for amount:', amount, 'Receipt ID:', receiptId);

        if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
            console.error('Razorpay keys are missing from environment variables.');
            return res.status(500).json({ error: 'Razorpay payment is not configured on the server. Please check RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.' });
        }

        // Razorpay expects the amount in the smallest currency unit (e.g., paise for INR)
        if (!amount || amount <= 0 || isNaN(amount)) {
            return res.status(400).json({ error: 'Valid amount in the smallest currency unit (paise) is required to create a payment order.' });
        }

        const options = {
            amount: amount, // amount in the smallest currency unit (e.g., paise)
            currency: 'INR', // Assuming INR, change if necessary
            receipt: receiptId || uuidv4(), // Unique receipt identifier
            payment_capture: 1 // Auto capture the payment
        };

        try {
            const order = await razorpay.orders.create(options);
            console.log('[/createOrder] Razorpay Order created successfully:', order.id);

            res.status(200).json({
                success: true,
                order_id: order.id,
                currency: 'INR',
                amount: order.amount,
                key_id: RAZORPAY_KEY_ID // Send Key ID to frontend for use with Razorpay.js
            });

        } catch (error) {
            console.error('[/createOrder] Error creating Razorpay order:', error.message);
            // Log the Razorpay API error details if available
            const errorDetails = error.error && error.error.description ? error.error.description : 'Unknown Razorpay error.';
            res.status(500).json({ error: 'Failed to create Razorpay order.', details: errorDetails });
        }
    });

    // ----------------------------------------------------------------------
    // NEW RAZORPAY SECURE WORKFLOW ENDPOINTS
    // ----------------------------------------------------------------------

    /**
     * NEW: Endpoint to initiate an order for online payment.
     * 1. Validates the order and calculates the final total amount.
     * 2. Creates a Razorpay Order ID (rzpOrderId).
     * 3. Saves the order in the database with status: 'pending'.
     * @param {Object} req.body - Full order payload.
     * @returns {Object} Contains the rzpOrderId, key_id, and server-calculated totalAmount.
     */
    app.post('/api/place-order', async (req, res) => {
        const { userId, items, totalAmount, customerName, customerContact, paymentMethod } = req.body;
        console.log('[/api/place-order] Received request to initiate order for customer:', customerName);

        // 1. Basic Validation for order initiation
        if (!userId || !items || !Array.isArray(items) || items.length === 0 || totalAmount === undefined || totalAmount === null || !customerName || !customerContact || paymentMethod !== 'online') {
            console.error('Validation failed for /api/place-order: Missing required fields or payment method is not "online".');
            return res.status(400).json({ error: 'User ID, items array, total amount, customer name, customer contact, and paymentMethod: "online" are required for order initiation.' });
        }
        
        // 2. Server-Side Price Calculation (Copied logic from the original /placeOrder)
        let totalAmountServerCalculated = 0;
        let maxEstimatedTime = 0;
        const processedItems = [];
        const FIXED_ADDITIONAL_TIME = 5;

        try {
            if (!ObjectId.isValid(userId)) {
                return res.status(400).json({ error: 'Invalid User ID format.' });
            }

            const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
            if (!user) {
                return res.status(404).json({ error: 'Shop owner user not found.' });
            }
            const hasSubscribed = user.hasSubscribed || false;
            const subscriptionExpiryDate = user.subscriptionExpiryDate ? new Date(user.subscriptionExpiryDate) : null;

            for (const item of items) {
                const foodObjectId = ObjectId.isValid(item.itemId) ? new ObjectId(item.itemId) : null;
                if (!foodObjectId) {
                    return res.status(400).json({ error: `Invalid item ID for food item: ${item.itemId}` });
                }

                const foodItemDB = await db.collection('foods').findOne({ _id: foodObjectId });
                if (!foodItemDB) {
                    return res.status(404).json({ error: `Food item not found for ID: ${item.itemId}` });
                }

                const { pricePerUnit, subtotal, effectiveQuantityCharged, subscriptionApplied } = calculateItemPriceServer( 
                    foodItemDB, item.quantity, item.unit, hasSubscribed, subscriptionExpiryDate
                );

                // Note: We skip the client-vs-server totalAmount comparison for now, assuming the client totalAmount is for display.
                // The crucial comparison will be against the server-calculated value.

                const currentItemEstimatedTime = Number(foodItemDB.estimatedTime);
                if (Number.isFinite(currentItemEstimatedTime) && currentItemEstimatedTime > maxEstimatedTime) {
                    maxEstimatedTime = currentItemEstimatedTime;
                }

                processedItems.push({
                    itemId: foodObjectId.toString(),
                    name: foodItemDB.food, 
                    quantity: parseInt(item.quantity),
                    effectiveQuantity: effectiveQuantityCharged,
                    unit: item.unit || foodItemDB.unit || foodItemDB.weightUnit || 'piece',
                    price: pricePerUnit,
                    originalPrice: foodItemDB.price,
                    priceBeforeDiscount: Math.round(calculatePriceIncrementBasedOnRange(foodItemDB.price) + foodItemDB.price),
                    discountType: foodItemDB.discountType || null,
                    discountValue: foodItemDB.discountValue || null,
                    otherDiscountText: foodItemDB.otherDiscountText || null,
                    tags: foodItemDB.tags || [], 
                    subtotal: subtotal,
                    customerComment: item.feedback || '',
                    customerLiked: typeof item.liked === 'boolean' ? item.liked : false, 
                    customerRating: item.rating ? parseInt(item.rating) : null,
                    estimatedTime: foodItemDB.estimatedTime || 0,
                    estimatedTimeUnit: foodItemDB.estimatedTimeUnit || 'minutes',
                    subscriptionApplied: subscriptionApplied 
                });
                totalAmountServerCalculated += subtotal;
            }

            totalAmountServerCalculated = parseFloat(totalAmountServerCalculated.toFixed(2));
            const estimatedDeliveryTime = maxEstimatedTime + FIXED_ADDITIONAL_TIME;

            // 3. Create Razorpay Order
            if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
                return res.status(500).json({ error: 'Razorpay payment is not configured on the server.' });
            }
            
            // Amount in paise (multiply by 100)
            const amountInPaise = Math.round(totalAmountServerCalculated * 100); 
            const receiptId = uuidv4(); // Use a new UUID as the receipt

            const razorpayOrderOptions = {
                amount: amountInPaise, 
                currency: 'INR', 
                receipt: receiptId,
                payment_capture: 0 // We will manually verify and capture (though often 1 is used for auto-capture, 0 is safer for manual flow)
            };

            const rzpOrder = await razorpay.orders.create(razorpayOrderOptions);
            console.log('[/api/place-order] Razorpay Order created with ID:', rzpOrder.id);

            // 4. Save Order to DB with 'pending' status
            const newOrder = {
                orderId: uuidv4(),
                rzpOrderId: rzpOrder.id, // Store Razorpay Order ID
                userId: new ObjectId(userId),
                customerName: customerName,
                customerContact: customerContact,
                items: processedItems, // Store processed items with feedback etc.
                totalAmount: totalAmountServerCalculated, 
                createdAt: new Date(),
                status: 'pending', // CRITICAL: Initial status is 'pending'
                paymentMethod: paymentMethod,
                transactionId: null,
                estimatedDeliveryTime: estimatedDeliveryTime,
                estimatedTimeUnit: 'minutes'
            };

            const result = await db.collection('orders').insertOne(newOrder);
            console.log('[/api/place-order] Order saved as pending with MongoDB _id:', result.insertedId);

            // 5. Send data back to client to open the Razorpay payment modal
            res.status(201).json({
                success: true,
                message: 'Payment order initiated. Proceed to payment.',
                orderId: newOrder.orderId, // Your internal order ID
                rzpOrderId: rzpOrder.id, // Razorpay Order ID
                key_id: RAZORPAY_KEY_ID, // Public Key
                amount: amountInPaise, // Amount in paise
                currency: 'INR'
            });

        } catch (err) {
            console.error('[/api/place-order] Error in order initiation:', err);
            res.status(500).json({ error: 'Failed to initiate order and Razorpay order.', details: err.message });
        }
    });

    /**
     * NEW: Endpoint to securely verify the payment signature.
     * 1. Uses crypto to verify the signature using RAZORPAY_KEY_SECRET.
     * 2. Finds the 'pending' order using the razorpayOrderId.
     * 3. Updates the order status to 'placed' and records the razorpayPaymentId.
     * @param {string} req.body.razorpayOrderId - The Razorpay Order ID.
     * @param {string} req.body.razorpayPaymentId - The Razorpay Payment ID.
     * @param {string} req.body.razorpaySignature - The signature generated by Razorpay.
     * @returns {Object} The finalized order details.
     */
    app.post('/api/verify-payment', async (req, res) => {
        const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
        console.log('[/api/verify-payment] Received verification request for RZP Order ID:', razorpayOrderId);

        if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
            return res.status(400).json({ error: 'Missing payment verification details.' });
        }
        
        if (!RAZORPAY_KEY_SECRET) {
            console.error('Razorpay Key Secret is missing. Cannot verify payment signature.');
            return res.status(500).json({ error: 'Server configuration error: Cannot verify payment.' });
        }

        // 1. Signature Verification
        const shasum = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET);
        shasum.update(`${razorpayOrderId}|${razorpayPaymentId}`);
        const digest = shasum.digest('hex');

        if (digest !== razorpaySignature) {
            console.error('[/api/verify-payment] Signature verification FAILED. Data Tampering Detected.');
            // Do not delete the order, just return an error so the client knows it failed.
            return res.status(400).json({ success: false, error: 'Payment verification failed. Signature mismatch.' });
        }

        console.log('[/api/verify-payment] Signature verification SUCCESSFUL.');

        try {
            // 2. Find the pending order
            const orderFilter = { 
                rzpOrderId: razorpayOrderId,
                status: 'pending' // Only finalize orders that are currently pending
            };

            const orderToUpdate = await db.collection('orders').findOne(orderFilter);

            if (!orderToUpdate) {
                console.error(`[/api/verify-payment] Pending order not found for RZP ID: ${razorpayOrderId}`);
                return res.status(404).json({ success: false, error: 'Order not found or already processed.' });
            }

            // 3. Update order status and transaction ID
            const updateResult = await db.collection('orders').updateOne(orderFilter, {
                $set: {
                    status: 'placed',
                    transactionId: razorpayPaymentId,
                    updatedAt: new Date()
                }
            });

            if (updateResult.modifiedCount === 0) {
                console.warn(`Order status update failed for RZP ID: ${razorpayOrderId}. It might have been updated by another process.`);
                return res.status(500).json({ success: false, error: 'Failed to update order status. Please check order history.' });
            }

            console.log('[/api/verify-payment] Order status updated to "placed". RZP ID:', razorpayOrderId);
            
            // 4. Handle embedded feedback (already saved in /api/place-order, no need to re-save, but ensure it's not forgotten)
            // The logic from the original /placeOrder to save feedback is now done in /api/place-order
            // because we need the feedback data to be available immediately for the item in case the payment fails.
            // If the original flow involved saving feedback *only* upon successful payment, that logic
            // would be here instead, but based on the provided logic of saving feedback during processing, 
            // no additional action is needed here.

            // Get the fully updated order for the client receipt page
            const finalOrder = await db.collection('orders').findOne({ rzpOrderId: razorpayOrderId });

            // 5. Output: Return the final, confirmed order data
            res.status(200).json({
                success: true,
                message: 'Payment verified and order placed successfully.',
                orderId: finalOrder.orderId,
                customerName: finalOrder.customerName,
                customerContact: finalOrder.customerContact,
                items: finalOrder.items, 
                totalAmount: finalOrder.totalAmount, 
                paymentMethod: finalOrder.paymentMethod,
                transactionId: finalOrder.transactionId,
                estimatedDeliveryTime: finalOrder.estimatedDeliveryTime,
                estimatedTimeUnit: finalOrder.estimatedTimeUnit
            });

        } catch (err) {
            console.error('[/api/verify-payment] Error finalizing order:', err);
            res.status(500).json({ success: false, error: 'Failed to verify payment or finalize order.', details: err.message });
        }
    });


    /**
     * Endpoint to place an order.
     * MODIFIED: This function now ONLY handles CASH and SCANQR payments.
     * It rejects 'online' payments, directing them to the new /api/place-order flow.
     * NEW: Calculates and stores estimatedDeliveryTime.
     * @param {string} req.body.userId - The ID of the shoper.
     * @param {Array<Object>} req.body.items - An array of ordered food items (from frontend).
     * @param {number} req.body.totalAmount - The total amount of the order (sent by frontend, re-calculated on backend).
     * @param {string} req.body.customerName - The name of the customer placing the order.
     * @param {string} req.body.customerContact - The contact information (email/phone) of the customer.
     * @param {string} req.body.paymentMethod - The payment method used (e.g., 'cash', 'upi', 'razorpay').
     * @param {string} [req.body.transactionId] - The transaction ID for online payments (e.g., Razorpay payment ID).
     */
    app.post('/placeOrder', async (req, res) => {
        const { userId, items, totalAmount, customerName, customerContact, paymentMethod, transactionId } = req.body;
        console.log('[/placeOrder] Received order request for customer:', customerName, 'Contact:', customerContact, 'Payment:', paymentMethod);
        console.log('Client-sent totalAmount:', totalAmount);


        // --- MODIFICATION: REJECT 'online' PAYMENTS ---
        if (paymentMethod === 'online') {
            return res.status(400).json({ 
                error: 'Online payment orders must use the new /api/place-order endpoint for secure processing. Please update the client-side API call.' 
            });
        }
        // --- END MODIFICATION ---

        // Validate required fields for placing a non-online order
        if (!userId || !items || !Array.isArray(items) || items.length === 0 || totalAmount === undefined || totalAmount === null || !customerName || !customerContact || !paymentMethod) {
            console.error('Validation failed for /placeOrder: Missing required fields.', { userId, items, totalAmount, customerName, customerContact, paymentMethod });
            return res.status(400).json({ error: 'User ID, items array, total amount, customer name, customer contact, and payment method are required for an order.' });
        }

        let totalAmountServerCalculated = 0; // Initialize here to ensure it's defined
        let maxEstimatedTime = 0; // Initialize to find the highest estimated time

        try {
            if (!ObjectId.isValid(userId)) {
                console.error(`Invalid User ID format received for /placeOrder: ${userId}`);
                return res.status(400).json({ error: 'Invalid User ID format.' });
            }

            // Fetch user details for subscription status for order calculation
            const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
            if (!user) {
                console.error(`Shop owner user not found for order placement. UserId: ${userId}`);
                return res.status(404).json({ error: 'Shop owner user not found for order placement.' });
            }
            const hasSubscribed = user.hasSubscribed || false;
            const subscriptionExpiryDate = user.subscriptionExpiryDate ? new Date(user.subscriptionExpiryDate) : null;
            console.log(`[/placeOrder] Shop owner subscription status for order: hasSubscribed=${hasSubscribed}, subscriptionExpiryDate=${subscriptionExpiryDate}`);


            const orderId = uuidv4();
            const processedItems = [];

            const FIXED_ADDITIONAL_TIME = 5; // Fixed additional minutes for the order

            for (const item of items) {
                const foodObjectId = ObjectId.isValid(item.itemId) ? new ObjectId(item.itemId) : null;
                if (!foodObjectId) {
                    console.error(`Invalid item ID in order payload: ${item.itemId}`);
                    return res.status(400).json({ error: `Invalid item ID for food item: ${item.itemId}` });
                }

                const foodItemDB = await db.collection('foods').findOne({ _id: foodObjectId });
                if (!foodItemDB) {
                    console.error(`Food item not found in DB for order: ${item.itemId}`);
                    return res.status(404).json({ error: `Food item not found for ID: ${item.itemId}` });
                }

                // Call calculateItemPriceServer with subscription status
                const { pricePerUnit, subtotal, effectiveQuantityCharged, subscriptionApplied } = calculateItemPriceServer( // Destructure subscriptionApplied
                    foodItemDB,
                    item.quantity,
                    item.unit,
                    hasSubscribed, // Pass subscription status
                    subscriptionExpiryDate // Pass subscription expiry date
                );

                const clientSubtotal = parseFloat(item.subtotal);
                const serverSubtotal = subtotal;

                if (Math.abs(clientSubtotal - serverSubtotal) > 0.01) {
                    console.warn(`Subtotal mismatch for item "${item.name}" (ID: ${item.itemId}): Client sent ${clientSubtotal.toFixed(2)}, Server calculated ${serverSubtotal.toFixed(2)}. Using server calculated value.`);
                    // You might choose to respond with an error here if the mismatch is too large
                    // return res.status(400).json({ error: 'Price manipulation detected or calculation mismatch.' });
                }

                const hasMeaningfulFeedback = (item.feedback && item.feedback.trim() !== '') ||
                    (item.rating !== null && item.rating !== undefined && item.rating !== 0) ||
                    item.liked;

                if (hasMeaningfulFeedback) {
                    const newFeedback = {
                        foodId: foodObjectId,
                        userId: new ObjectId(userId), // This is the shoper's userId
                        customerName: customerName,
                        comment: item.feedback || '',
                        liked: typeof item.liked === 'boolean' ? item.liked : false, // Ensure boolean for liked
                        rating: item.rating ? parseInt(item.rating) : null,
                        createdAt: new Date()
                    };
                    await db.collection('feedbacks').insertOne(newFeedback);
                    console.log(`[/placeOrder] Automatically saved feedback for foodId: ${foodObjectId} from order.`);
                } else {
                    console.log(`[/placeOrder] No specific feedback provided for foodId: ${foodObjectId} during order. Skipping feedback insert.`);
                }

                // Determine the maximum estimated time among all items
                const currentItemEstimatedTime = Number(foodItemDB.estimatedTime); // Explicitly convert to number
                if (Number.isFinite(currentItemEstimatedTime) && currentItemEstimatedTime > maxEstimatedTime) {
                    maxEstimatedTime = currentItemEstimatedTime;
                }

                processedItems.push({
                    itemId: foodObjectId.toString(),
                    name: foodItemDB.food, // Use the actual food name from DB
                    quantity: parseInt(item.quantity), // Original quantity ordered by customer
                    effectiveQuantity: effectiveQuantityCharged, // Quantity actually charged after discount
                    unit: item.unit || foodItemDB.unit || foodItemDB.weightUnit || 'piece',
                    price: pricePerUnit, // Price per unit after subscription increment and % or flat discount
                    originalPrice: foodItemDB.price, // Original base price from DB
                    // Include the price after range increment but before subscription/discounts for receipt display
                    priceBeforeDiscount: Math.round(calculatePriceIncrementBasedOnRange(foodItemDB.price) + foodItemDB.price),
                    discountType: foodItemDB.discountType || null,
                    discountValue: foodItemDB.discountValue || null,
                    otherDiscountText: foodItemDB.otherDiscountText || null,
                    tags: foodItemDB.tags || [], // NEW: Include tags in the order item
                    subtotal: serverSubtotal, // Use server-calculated subtotal
                    customerComment: item.feedback || '',
                    customerLiked: typeof item.liked === 'boolean' ? item.liked : false, // Ensure boolean for liked
                    customerRating: item.rating ? parseInt(item.rating) : null,
                    estimatedTime: foodItemDB.estimatedTime || 0, // Include item's estimated time
                    estimatedTimeUnit: foodItemDB.estimatedTimeUnit || 'minutes', // Include item's estimated time unit
                    subscriptionApplied: subscriptionApplied // Pass the flag from server-side calculation
                });
                totalAmountServerCalculated += serverSubtotal;
            }

            // Calculate estimated delivery time: highest item time + fixed additional time
            const estimatedDeliveryTime = maxEstimatedTime + FIXED_ADDITIONAL_TIME;

            // Important: Round the final calculated total for comparison to avoid floating point issues
            totalAmountServerCalculated = parseFloat(totalAmountServerCalculated.toFixed(2));

            if (Math.abs(totalAmount - totalAmountServerCalculated) > 0.02) {
                console.warn(`Total amount mismatch: Client sent ${totalAmount.toFixed(2)}, Server calculated ${totalAmountServerCalculated.toFixed(2)}. Using server calculated value.`);
                // You might choose to respond with an error here if the mismatch is too large
                // return res.status(400).json({ error: 'Price manipulation detected or calculation mismatch.' });
            }

            const newOrder = {
                orderId: uuidv4(), // Generate a unique order ID
                userId: new ObjectId(userId),
                customerName: customerName,
                customerContact: customerContact,
                items: processedItems,
                totalAmount: totalAmountServerCalculated, // Use the server-calculated total
                createdAt: new Date(),
                status: 'placed', // Directly set to 'placed' for cash/scanqr
                paymentMethod: paymentMethod,
                transactionId: transactionId || null,
                estimatedDeliveryTime: estimatedDeliveryTime, // Store estimated delivery time
                estimatedTimeUnit: 'minutes' // Store estimated delivery time unit
            };

            const result = await db.collection('orders').insertOne(newOrder);
            console.log('[/placeOrder] Order inserted with MongoDB _id:', result.insertedId, 'and custom orderId:', newOrder.orderId);

            res.status(201).json({
                success: true,
                orderId: newOrder.orderId,
                customerName: customerName,
                customerContact: customerContact,
                message: 'Order placed successfully.',
                items: processedItems, // Return the processed items including effectiveQuantity and server-calculated subtotal
                totalAmount: newOrder.totalAmount, // Use the actual total from the saved order
                paymentMethod: paymentMethod,
                transactionId: transactionId || null,
                estimatedDeliveryTime: newOrder.estimatedDeliveryTime, // Send estimated delivery time to frontend
                estimatedTimeUnit: newOrder.estimatedTimeUnit // Explicitly send the unit to frontend for display
            });

        } catch (err) {
            console.error("Error processing order:", err);
            res.status(500).json({ error: 'Failed to process order.', details: err.message });
        }
    });
})();
    // Start the Express server and listen on the specified port
   module.exports = app;

