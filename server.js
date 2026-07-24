const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS enable karna taaki request block na ho
app.use(cors());

// Middleware taaki JSON data read ho sake
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database Connection (Render ya Local ke liye)
const db = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'genro_db',
    port: process.env.DB_PORT || 3306
});

db.connect((err) => {
    if (err) {
        console.error('Database connection failed: ' + err.stack);
        return;
    }
    console.log('Connected to MySQL Database successfully!');
});

// 1. GENRO ka Main Data API (Jo pehle se tha)
app.post('/api/genro/data', (req, res) => {
    const incomingData = req.body;
    console.log("GENRO App se naya data mila:", incomingData);
    res.json({
        success: true,
        message: "Data successfully received by GENRO backend!",
        receivedData: incomingData
    });
});

// 2. NAYI API: Syllabus Fetch karne ke liye (UI ke liye sabse important)
app.get('/api/syllabus/:class_level/:subject_name', (req, res) => {
    const { class_level, subject_name } = req.params;
    
    // Query jo chapters aur topics ko exact NCERT sequence mein laayegi
    const query = `
        SELECT c.chapter_id, c.chapter_number, c.chapter_name, 
               t.topic_id, t.topic_sequence, t.topic_name, t.video_url
        FROM chapters c
        LEFT JOIN topics t ON c.chapter_id = t.chapter_id
        WHERE c.class_level = ? AND c.subject_name = ?
        ORDER BY c.chapter_number ASC, t.topic_sequence ASC;
    `;

    db.query(query, [class_level, subject_name], (err, results) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ success: false, error: "Database query failed" });
        }
        
        // Data ko chapters ke andar topics ke format mein group karna
        const chaptersMap = {};
        results.forEach(row => {
            if (!chaptersMap[row.chapter_id]) {
                chaptersMap[row.chapter_id] = {
                    chapter_id: row.chapter_id,
                    chapter_number: row.chapter_number,
                    chapter_name: row.chapter_name,
                    topics: []
                };
            }
            if (row.topic_id) {
                chaptersMap[row.chapter_id].topics.push({
                    topic_id: row.topic_id,
                    topic_sequence: row.topic_sequence,
                    topic_name: row.topic_name,
                    video_url: row.video_url || ""
                });
            }
        });

        res.status(200).json({
            success: true,
            data: Object.values(chaptersMap)
        });
    });
});

// Server start
app.listen(PORT, () => {
    console.log(`GENRO Server is running on port ${PORT}`);
});