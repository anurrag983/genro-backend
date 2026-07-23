const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

// CORS enable karna taaki mobile app se request block na ho
app.use(cors());

// Middleware taaki JSON data read ho sake
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// GENRO ka Main Data API (Jo Rayaan use karega)
app.post('/api/genro/data', (req, res) => {
    const incomingData = req.body;
    
    console.log("GENRO App se naya data mila:", incomingData);

    // App ko success response bhejna
    res.json({
        success: true,
        message: "Data successfully received by GENRO backend!",
        receivedData: incomingData
    });
});

// Server start
app.listen(PORT, () => {
    console.log(`GENRO Server is running on port ${PORT}`);
});