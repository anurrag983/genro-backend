const express = require('express');
const bcrypt = require('bcryptjs'); // Naya add hua password hashing ke liye
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
    port: process.env.DB_PORT || 3306,
    timezone: '+05:30'
});

db.connect((err) => {
    if (err) {
        console.error('Database connection failed: ' + err.stack);
        return;
    }
    console.log('Connected to MySQL Database successfully!');
});

// ==========================================
// 1. GENRO ka Main Data API (Jo pehle se tha)
// ==========================================
app.post('/api/genro/data', (req, res) => {
    const incomingData = req.body;
    console.log("GENRO App se naya data mila:", incomingData);
    res.json({
        success: true,
        message: "Data successfully received by GENRO backend!",
        receivedData: incomingData
    });
});

// ==========================================
// 2. Syllabus API (Tumhara original chaptersMap wala logic)
// ==========================================
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

// ==========================================
// 3. NAYA: USER SIGNUP API (POST) [Updated with AM/PM Time]
// ==========================================
app.post('/api/signup', async (req, res) => {
    const { full_name, mobile_no, email, password, class_level, board } = req.body;

    if (!full_name || !mobile_no || !email || !password) {
        return res.status(400).json({ success: false, message: "Saari details bharna zaroori hai!" });
    }

    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // 12-hour format aur AM/PM ke sath IST time generate karne ka code
        const indianTimeOptions = { 
            timeZone: "Asia/Kolkata", 
            year: 'numeric', 
            month: '2-digit', 
            day: '2-digit', 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit', 
            hour12: true // AM/PM enable kiya gaya hai
        };
        const formatter = new Intl.DateTimeFormat('en-US', indianTimeOptions);
        const formattedISTTime = formatter.format(new Date());

        const insertQuery = `
            INSERT INTO users (full_name, mobile_no, email, password_hash, class_level, board, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `;

        db.query(insertQuery, [full_name, mobile_no, email, hashedPassword, class_level, board, formattedISTTime], (err, result) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') {
                    return res.status(400).json({ success: false, message: "Yeh Email ya Mobile pehle se registered hai!" });
                }
                console.error("Database error: ", err);
                return res.status(500).json({ success: false, message: "Database error aaya hai." });
            }

            res.status(201).json({
                success: true,
                message: "User account successfully ban gaya!",
                user_id: result.insertId
            });
        });
    } catch (error) {
        console.error("Server error: ", error);
        res.status(500).json({ success: false, message: "Server error." });
    }
});


// ---------------------------------------------------------
// 🚀 YAHAN SE SAARI NAYI APIs SHURU HOTI HAIN 
// ---------------------------------------------------------


// ==========================================
// 4. USER LOGIN API (POST)
// ==========================================
app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: "Email aur password zaroori hai!" });
    }

    const query = `SELECT * FROM users WHERE email = ?`;
    db.query(query, [email], async (err, results) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        if (results.length === 0) return res.status(404).json({ success: false, message: "User nahi mila! Pehle signup karein." });

        const user = results[0];
        
        // Hash password ko compare karna
        const isMatch = await bcrypt.compare(password, user.password_hash);

        if (!isMatch) {
            return res.status(401).json({ success: false, message: "Galat password!" });
        }

        res.status(200).json({
            success: true,
            message: "Login successful!",
            data: {
                user_id: user.user_id,
                full_name: user.full_name,
                class_level: user.class_level,
                board: user.board
            }
        });
    });
});

// ==========================================
// 5. FETCH TEST JSON URL API (GET)
// ==========================================
app.get('/api/test/:topic_id', (req, res) => {
    const { topic_id } = req.params;

    const query = `SELECT topic_id, topic_name, test_json_url FROM topics WHERE topic_id = ?`;

    db.query(query, [topic_id], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: "Database query failed" });
        if (results.length === 0) return res.status(404).json({ success: false, message: "Topic nahi mila!" });

        const topicData = results[0];

        if (!topicData.test_json_url) {
            return res.status(404).json({ success: false, message: "Is topic ke liye test abhi available nahi hai." });
        }

        res.status(200).json({
            success: true,
            data: topicData
        });
    });
});

// ==========================================
// 6. USER DASHBOARD API (GET)
// ==========================================
app.get('/api/user/:user_id/dashboard', (req, res) => {
    const { user_id } = req.params;

    const query = `SELECT full_name, class_level, board, total_xp, day_streak, enrolled_subjects 
                   FROM users WHERE user_id = ?`;

    db.query(query, [user_id], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        if (results.length === 0) return res.status(404).json({ success: false, message: "User nahi mila!" });

        res.status(200).json({
            success: true,
            data: results[0]
        });
    });
});

// ==========================================
// 7. UPDATE USER PROGRESS API (POST)
// ==========================================
app.post('/api/user/:user_id/progress', (req, res) => {
    const { user_id } = req.params;
    const { topic_id, status, accuracy_percentage, xp_earned } = req.body;

    if (!topic_id || !status) {
        return res.status(400).json({ success: false, message: "Topic ID aur Status dena zaroori hai" });
    }

    // Pehle check karo ki user ne ye topic pehle test kiya hai ya nahi
    const checkQuery = `SELECT * FROM user_progress WHERE user_id = ? AND topic_id = ?`;
    
    db.query(checkQuery, [user_id, topic_id], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });

        if (results.length > 0) {
            // Agar pehle se entry hai, toh update karo
            const updateProgQuery = `
                UPDATE user_progress 
                SET status = ?, accuracy_percentage = ?, tests_attempted = tests_attempted + 1, xp_earned = xp_earned + ? 
                WHERE user_id = ? AND topic_id = ?
            `;
            db.query(updateProgQuery, [status, accuracy_percentage, xp_earned, user_id, topic_id]);
        } else {
            // Agar pehli baar test diya hai, toh nayi row insert karo
            const insertProgQuery = `
                INSERT INTO user_progress (user_id, topic_id, status, accuracy_percentage, tests_attempted, xp_earned) 
                VALUES (?, ?, ?, ?, 1, ?)
            `;
            db.query(insertProgQuery, [user_id, topic_id, status, accuracy_percentage, xp_earned]);
        }

        // Iske baad, Users table mein User ka Total XP bhi update kardo
        const updateXPQuery = `UPDATE users SET total_xp = total_xp + ? WHERE user_id = ?`;
        db.query(updateXPQuery, [xp_earned, user_id], (err2) => {
            if (err2) return res.status(500).json({ success: false, message: "Progress save hui par total XP update nahi ho paya" });
            
            res.status(200).json({ success: true, message: "Progress aur XP successfully update ho gaye!" });
        });
    });
});

// ==========================================
// 8. AI CHAT HISTORY API (GET & POST)
// ==========================================

// 8A. Pichli chat mangwane ke liye (GET)
app.get('/api/chat/:user_id', (req, res) => {
    const { user_id } = req.params;
    const query = `SELECT sender_type, message_text, created_at 
                   FROM ai_chat_history WHERE user_id = ? ORDER BY created_at ASC`;

    db.query(query, [user_id], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        res.status(200).json({ success: true, data: results });
    });
});

// 8B. Naya message save karne ke liye (POST)
app.post('/api/chat/:user_id', (req, res) => {
    const { user_id } = req.params;
    const { sender_type, message_text } = req.body; 

    if (!sender_type || !message_text) {
        return res.status(400).json({ success: false, message: "Sender Type aur Message dono zaroori hain!" });
    }

    const query = `INSERT INTO ai_chat_history (user_id, sender_type, message_text) VALUES (?, ?, ?)`;
    
    db.query(query, [user_id, sender_type, message_text], (err, result) => {
        if (err) return res.status(500).json({ success: false, message: "Failed to save message" });
        res.status(201).json({ success: true, message: "Message successfully saved in history!" });
    });
});

// ==========================================
// SERVER START
// ==========================================
app.listen(PORT, () => {
    console.log(`GENRO Server is running on port ${PORT}`);
});
