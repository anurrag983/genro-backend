const express = require('express');
const bcrypt = require('bcryptjs'); // Password hashing ke liye
const cors = require('cors');
const mysql = require('mysql2');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// MIDDLEWARE
// ==========================================
// CORS enable karna taaki request block na ho. FRONTEND_URL env var set karke
// isse specific domain(s) tak restrict kiya ja sakta hai (comma-separated).
app.use(cors({
    origin: process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',').map(s => s.trim()) : '*'
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ==========================================
// DATABASE CONNECTION (POOL)
// ==========================================
// FIX: A single mysql.createConnection() silently dies on idle timeout / network
// blips and every request after that fails until the process restarts. A pool
// hands out a fresh connection per request and reconnects automatically, which
// is what you want under real traffic on Render.
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'genro_db',
    port: process.env.DB_PORT || 3306,
    timezone: '+05:30',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const db = pool.promise();

// Quick boot-time check so a bad DB config fails loudly instead of every route
// failing silently later.
pool.query('SELECT 1', (err) => {
    if (err) {
        console.error('Database connection failed: ' + err.message);
        return;
    }
    console.log('Connected to MySQL Database successfully!');
});

// Wraps an async route handler so a rejected promise reaches Express's error
// handler instead of crashing the process or hanging the request.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function getIstTimestamp() {
    const indianTimeOptions = {
        timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    };
    const formatter = new Intl.DateTimeFormat([], indianTimeOptions);
    const dParts = formatter.formatToParts(new Date());
    const d = {};
    dParts.forEach(p => (d[p.type] = p.value));
    return `${d.year}-${d.month}-${d.day} ${d.hour}:${d.minute}:${d.second}`;
}

// ==========================================
// 0. HEALTH CHECK (Render pings "/" — avoid a bare "Cannot GET /")
// ==========================================
app.get('/', (req, res) => {
    res.json({ success: true, message: 'GENRO Server is alive' });
});

// ==========================================
// 1. GENRO ka Main Data API (Jo pehle se tha)
// ==========================================
app.post('/api/genro/data', (req, res) => {
    const incomingData = req.body;
    console.log('GENRO App se naya data mila:', incomingData);
    res.json({
        success: true,
        message: 'Data successfully received by GENRO backend!',
        receivedData: incomingData
    });
});

// ==========================================
// 2. SYLLABUS API — chapters + nested topics in NCERT sequence
// ==========================================
app.get('/api/syllabus/:class_level/:subject_name', ah(async (req, res) => {
    const { class_level, subject_name } = req.params;

    const [results] = await db.query(
        `SELECT c.chapter_id, c.chapter_number, c.chapter_name, c.test_json_url AS chapter_test_json_url,
                t.topic_id, t.topic_sequence, t.topic_name, t.video_url, t.test_json_url AS topic_test_json_url
         FROM chapters c
         LEFT JOIN topics t ON c.chapter_id = t.chapter_id
         WHERE c.class_level = ? AND c.subject_name = ?
         ORDER BY c.chapter_number ASC, t.topic_sequence ASC`,
        [class_level, subject_name]
    );

    const chaptersMap = {};
    results.forEach(row => {
        if (!chaptersMap[row.chapter_id]) {
            chaptersMap[row.chapter_id] = {
                chapter_id: row.chapter_id,
                chapter_number: row.chapter_number,
                chapter_name: row.chapter_name,
                has_chapter_test: !!row.chapter_test_json_url,
                topics: []
            };
        }
        if (row.topic_id) {
            chaptersMap[row.chapter_id].topics.push({
                topic_id: row.topic_id,
                topic_sequence: row.topic_sequence,
                topic_name: row.topic_name,
                video_url: row.video_url || '',
                has_test: !!row.topic_test_json_url
            });
        }
    });

    res.status(200).json({ success: true, data: Object.values(chaptersMap) });
}));

// ==========================================
// 3. OTP APIS (Signup se pehle mobile verify karne ke liye)
// ==========================================
// SIMULATED OTP: koi SMS gateway (Twilio / MSG91 / Firebase) is codebase mein
// configured nahi hai, isliye OTP ek in-memory store mein rakha jaata hai aur
// demo mode mein response ke andar hi wapas bhej diya jaata hai taaki aap bina
// SMS provider ke pura signup flow test kar sakein. Production mein:
//   1) OTP_DEMO_MODE=false set karein (.env mein) taaki otp_debug field hat jaaye
//   2) Neeche wale `sendSms()` stub ko apne real SMS provider se replace karein
//   3) In-memory Map ki jagah Redis / DB table use karein (multi-instance ke liye)
const otpStore = new Map(); // mobile_no -> { otp, expiresAt, verified }
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_DEMO_MODE = process.env.OTP_DEMO_MODE !== 'false';

function generateOtp() {
    return String(Math.floor(1000 + Math.random() * 9000));
}

async function sendSms(mobile_no, otp) {
    // TODO: replace with a real SMS gateway call. Left as a console log so the
    // demo flow works out of the box with zero external configuration.
    console.log(`[OTP DEMO] ${mobile_no} ko bhejna hai OTP: ${otp}`);
    return true;
}

app.post('/api/otp/send', ah(async (req, res) => {
    const { mobile_no } = req.body;
    if (!mobile_no || !/^[0-9]{10}$/.test(String(mobile_no))) {
        return res.status(400).json({ success: false, message: 'Sahi 10-digit mobile number dena zaroori hai!' });
    }

    const otp = generateOtp();
    otpStore.set(mobile_no, { otp, expiresAt: Date.now() + OTP_TTL_MS, verified: false });
    await sendSms(mobile_no, otp);

    res.status(200).json({
        success: true,
        message: 'OTP bhej diya gaya hai!',
        ...(OTP_DEMO_MODE ? { otp_debug: otp, demo_mode: true } : {})
    });
}));

app.post('/api/otp/verify', ah(async (req, res) => {
    const { mobile_no, otp } = req.body;
    if (!mobile_no || !otp) {
        return res.status(400).json({ success: false, message: 'Mobile number aur OTP dono zaroori hain!' });
    }

    const entry = otpStore.get(mobile_no);
    if (!entry) {
        return res.status(400).json({ success: false, message: 'Pehle OTP request karein.' });
    }
    if (Date.now() > entry.expiresAt) {
        otpStore.delete(mobile_no);
        return res.status(400).json({ success: false, message: 'OTP expire ho gaya hai, dobara bhejein.' });
    }
    if (String(entry.otp) !== String(otp)) {
        return res.status(400).json({ success: false, message: 'Galat OTP!' });
    }

    entry.verified = true;
    otpStore.set(mobile_no, entry);
    res.status(200).json({ success: true, message: 'Mobile number verify ho gaya!' });
}));

// ==========================================
// 4. USER SIGNUP API (POST)
// ==========================================
app.post('/api/signup', ah(async (req, res) => {
    const { full_name, mobile_no, email, password, class_level, board } = req.body;

    if (!full_name || !mobile_no || !email || !password || !class_level || !board) {
        return res.status(400).json({ success: false, message: 'Saari details bharna zaroori hai!' });
    }
    if (password.length < 6) {
        return res.status(400).json({ success: false, message: 'Password kam se kam 6 characters ka hona chahiye!' });
    }

    // Mobile OTP verify hua tha ya nahi, ye server-side confirm karte hain
    // (sirf frontend par bharosa nahi karte).
    const otpEntry = otpStore.get(mobile_no);
    if (!otpEntry || !otpEntry.verified) {
        return res.status(400).json({ success: false, message: 'Pehle mobile number ko OTP se verify karein!' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const formattedISTTime = getIstTimestamp();
    const enrolledSubjects = JSON.stringify(['Physics', 'Chemistry', 'Maths', 'Biology']);

    try {
        const [result] = await db.query(
            `INSERT INTO users (full_name, mobile_no, email, password_hash, class_level, board, enrolled_subjects, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [full_name, mobile_no, email, hashedPassword, class_level, board, enrolledSubjects, formattedISTTime]
        );

        otpStore.delete(mobile_no); // cleanup, isko dobara verify karne ki zaroorat nahi

        res.status(201).json({
            success: true,
            message: 'User account successfully ban gaya!',
            user_id: result.insertId
        });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ success: false, message: 'Yeh Email ya Mobile pehle se registered hai!' });
        }
        throw err;
    }
}));

// ==========================================
// 5. USER LOGIN API (POST)
// ==========================================
app.post('/api/auth/login', ah(async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email aur password zaroori hai!' });
    }

    const [results] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (results.length === 0) {
        return res.status(404).json({ success: false, message: 'User nahi mila! Pehle signup karein.' });
    }

    const user = results[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
        return res.status(401).json({ success: false, message: 'Galat password!' });
    }

    res.status(200).json({
        success: true,
        message: 'Login successful!',
        data: {
            user_id: user.user_id,
            full_name: user.full_name,
            email: user.email,
            mobile_no: user.mobile_no,
            class_level: user.class_level,
            board: user.board,
            total_xp: user.total_xp,
            day_streak: user.day_streak
        }
    });
}));

// ==========================================
// 6. FETCH TEST JSON URL APIS (GET)
// ==========================================
// NOTE: iska specific route generic "/:topic_id" route se PEHLE define hona
// zaroori hai, warna Express "chapter" ko hi ek topic_id samajh lega.
app.get('/api/test/chapter/:chapter_id', ah(async (req, res) => {
    const { chapter_id } = req.params;
    const [results] = await db.query(
        'SELECT chapter_id, chapter_name, test_json_url FROM chapters WHERE chapter_id = ?',
        [chapter_id]
    );
    if (results.length === 0) {
        return res.status(404).json({ success: false, message: 'Chapter nahi mila!' });
    }
    if (!results[0].test_json_url) {
        return res.status(404).json({ success: false, message: 'Is chapter ke liye full test abhi available nahi hai.' });
    }
    res.status(200).json({ success: true, data: results[0] });
}));

app.get('/api/test/:topic_id', ah(async (req, res) => {
    const { topic_id } = req.params;
    const [results] = await db.query(
        'SELECT topic_id, topic_name, test_json_url FROM topics WHERE topic_id = ?',
        [topic_id]
    );
    if (results.length === 0) {
        return res.status(404).json({ success: false, message: 'Topic nahi mila!' });
    }
    if (!results[0].test_json_url) {
        return res.status(404).json({ success: false, message: 'Is topic ke liye test abhi available nahi hai.' });
    }
    res.status(200).json({ success: true, data: results[0] });
}));

// ==========================================
// 7. USER DASHBOARD API (GET)
// ==========================================
app.get('/api/user/:user_id/dashboard', ah(async (req, res) => {
    const { user_id } = req.params;
    const [results] = await db.query(
        `SELECT user_id, full_name, email, mobile_no, class_level, board, total_xp, day_streak, enrolled_subjects
         FROM users WHERE user_id = ?`,
        [user_id]
    );
    if (results.length === 0) {
        return res.status(404).json({ success: false, message: 'User nahi mila!' });
    }
    res.status(200).json({ success: true, data: results[0] });
}));

// ==========================================
// 8. UPDATE PROFILE API (PUT) — spec ke "Edit Profile" ke liye zaroori,
//    pehle iske liye koi endpoint nahi tha.
// ==========================================
app.put('/api/user/:user_id/profile', ah(async (req, res) => {
    const { user_id } = req.params;
    const { full_name, email, mobile_no, class_level, board } = req.body;

    if (!full_name || !email || !mobile_no) {
        return res.status(400).json({ success: false, message: 'Naam, Email aur Mobile zaroori hain!' });
    }

    try {
        const [result] = await db.query(
            `UPDATE users SET full_name = ?, email = ?, mobile_no = ?,
                class_level = COALESCE(?, class_level), board = COALESCE(?, board)
             WHERE user_id = ?`,
            [full_name, email, mobile_no, class_level || null, board || null, user_id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'User nahi mila!' });
        }
        res.status(200).json({ success: true, message: 'Profile update ho gayi!' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ success: false, message: 'Yeh Email ya Mobile pehle se kisi aur account mein hai!' });
        }
        throw err;
    }
}));

// ==========================================
// 9. UPDATE USER PROGRESS API (POST) — test complete hone ke baad
// ==========================================
app.post('/api/user/:user_id/progress', ah(async (req, res) => {
    const { user_id } = req.params;
    const { topic_id, status, accuracy_percentage, xp_earned } = req.body;

    if (!topic_id || !status) {
        return res.status(400).json({ success: false, message: 'Topic ID aur Status dena zaroori hai' });
    }

    const [existing] = await db.query(
        'SELECT progress_id FROM user_progress WHERE user_id = ? AND topic_id = ?',
        [user_id, topic_id]
    );

    if (existing.length > 0) {
        await db.query(
            `UPDATE user_progress
             SET status = ?, accuracy_percentage = ?, tests_attempted = tests_attempted + 1,
                 xp_earned = xp_earned + ?, last_tested_at = CURRENT_TIMESTAMP
             WHERE user_id = ? AND topic_id = ?`,
            [status, accuracy_percentage, xp_earned, user_id, topic_id]
        );
    } else {
        await db.query(
            `INSERT INTO user_progress (user_id, topic_id, status, accuracy_percentage, tests_attempted, xp_earned)
             VALUES (?, ?, ?, ?, 1, ?)`,
            [user_id, topic_id, status, accuracy_percentage, xp_earned]
        );
    }

    // Progress row confirm hone ke BAAD hi total XP badhate hain (properly chained,
    // taaki pool ke alag-alag connections par ye do writes kabhi race na karein).
    await db.query('UPDATE users SET total_xp = total_xp + ? WHERE user_id = ?', [xp_earned, user_id]);

    const [[updatedUser]] = await db.query('SELECT total_xp, day_streak FROM users WHERE user_id = ?', [user_id]);

    res.status(200).json({
        success: true,
        message: 'Progress aur XP successfully update ho gaye!',
        data: { total_xp: updatedUser?.total_xp, day_streak: updatedUser?.day_streak }
    });
}));

// ==========================================
// 10. GET FULL PROGRESS LIST (GET) — "Your Progress" screen ke liye zaroori,
//     pehle sirf POST tha, list wapas karne ka koi endpoint nahi tha.
// ==========================================
app.get('/api/user/:user_id/progress', ah(async (req, res) => {
    const { user_id } = req.params;

    const [rows] = await db.query(
        `SELECT up.progress_id, up.topic_id, up.status, up.accuracy_percentage, up.tests_attempted,
                up.xp_earned, up.last_tested_at, t.topic_name, t.video_url,
                c.chapter_id, c.chapter_name, c.subject_name
         FROM user_progress up
         JOIN topics t ON up.topic_id = t.topic_id
         JOIN chapters c ON t.chapter_id = c.chapter_id
         WHERE up.user_id = ?
         ORDER BY up.last_tested_at DESC`,
        [user_id]
    );

    const totalTests = rows.reduce((sum, r) => sum + r.tests_attempted, 0);
    const avgAccuracy = rows.length
        ? rows.reduce((sum, r) => sum + Number(r.accuracy_percentage), 0) / rows.length
        : 0;

    res.status(200).json({
        success: true,
        data: {
            summary: {
                total_tests: totalTests,
                avg_accuracy: Math.round(avgAccuracy * 10) / 10,
                topics_covered: rows.length
            },
            strong_topics: rows.filter(r => Number(r.accuracy_percentage) >= 70),
            weak_topics: rows.filter(r => Number(r.accuracy_percentage) < 50),
            all_progress: rows
        }
    });
}));

// ==========================================
// 11. AI CHAT HISTORY API (GET & POST & PUT & DELETE)
// ==========================================

// 11A. Pichli chat mangwane ke liye (GET)
app.get('/api/chat/:user_id', ah(async (req, res) => {
    const { user_id } = req.params;
    const [results] = await db.query(
        `SELECT message_id, sender_type, message_text, created_at
         FROM ai_chat_history WHERE user_id = ? ORDER BY created_at ASC, message_id ASC`,
        [user_id]
    );
    res.status(200).json({ success: true, data: results });
}));

// Very small rule-based tutor used when ANTHROPIC_API_KEY isn't configured, so
// the chat never breaks — it just isn't "smart" until you add a real key.
function fallbackAiReply(userText) {
    return `Aapne poocha: "${userText}". Abhi is server par koi live AI model connect nahi hai — ` +
        `ANTHROPIC_API_KEY environment variable set karke real AI jawaab enable karein ` +
        `(dekhein server.js mein generateAiReply function). Tab tak, Study section mein jaakar ` +
        `related topic dhoondh kar concept video dekhein!`;
}

// Real AI reply via the Claude API — only runs if a key is configured. Swap
// ANTHROPIC_MODEL for any current Claude model string.
async function generateAiReply(userText) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return fallbackAiReply(userText);

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
                max_tokens: 500,
                system: 'You are Genro AI, a friendly, encouraging study buddy for Indian Class 11-12 ' +
                    'students preparing for NEET and board exams (Physics, Chemistry, Maths, Biology). ' +
                    'Explain concepts simply and concisely, in the same mix of Hindi and English (Hinglish) ' +
                    'the student writes in. Keep answers focused and exam-relevant.',
                messages: [{ role: 'user', content: userText }]
            })
        });

        if (!response.ok) throw new Error(`Anthropic API returned ${response.status}`);
        const data = await response.json();
        const text = data?.content?.find(block => block.type === 'text')?.text;
        return text || fallbackAiReply(userText);
    } catch (err) {
        console.error('AI reply failed, using fallback:', err.message);
        return fallbackAiReply(userText);
    }
}

// 11B. Naya message save karne ke liye (POST). Agar sender User hai, to server
// khud AI ka reply generate karke save bhi kar deta hai aur dono wapas bhejta
// hai — isse frontend ko doosri round-trip nahi karni padti.
app.post('/api/chat/:user_id', ah(async (req, res) => {
    const { user_id } = req.params;
    const { sender_type, message_text } = req.body;

    if (!sender_type || !message_text) {
        return res.status(400).json({ success: false, message: 'Sender Type aur Message dono zaroori hain!' });
    }

    const [userInsert] = await db.query(
        'INSERT INTO ai_chat_history (user_id, sender_type, message_text) VALUES (?, ?, ?)',
        [user_id, sender_type, message_text]
    );

    const savedUserMessage = { message_id: userInsert.insertId, sender_type, message_text };

    if (sender_type !== 'User') {
        return res.status(201).json({ success: true, message: 'Message successfully saved in history!', data: { user_message: savedUserMessage } });
    }

    const aiText = await generateAiReply(message_text);
    const [aiInsert] = await db.query(
        "INSERT INTO ai_chat_history (user_id, sender_type, message_text) VALUES (?, 'Genro_AI', ?)",
        [user_id, aiText]
    );
    const savedAiMessage = { message_id: aiInsert.insertId, sender_type: 'Genro_AI', message_text: aiText };

    res.status(201).json({
        success: true,
        message: 'Message successfully saved in history!',
        data: { user_message: savedUserMessage, ai_message: savedAiMessage }
    });
}));

// 11C. Message edit karne ke liye (PUT)
app.put('/api/chat/:user_id/:message_id', ah(async (req, res) => {
    const { user_id, message_id } = req.params;
    const { message_text } = req.body;

    if (!message_text || !message_text.trim()) {
        return res.status(400).json({ success: false, message: 'Message khali nahi ho sakta!' });
    }

    const [result] = await db.query(
        'UPDATE ai_chat_history SET message_text = ? WHERE message_id = ? AND user_id = ?',
        [message_text, message_id, user_id]
    );
    if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: 'Message nahi mila!' });
    }
    res.status(200).json({ success: true, message: 'Message update ho gaya!' });
}));

// 11D. Message delete karne ke liye (DELETE)
app.delete('/api/chat/:user_id/:message_id', ah(async (req, res) => {
    const { user_id, message_id } = req.params;
    const [result] = await db.query(
        'DELETE FROM ai_chat_history WHERE message_id = ? AND user_id = ?',
        [message_id, user_id]
    );
    if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: 'Message nahi mila!' });
    }
    res.status(200).json({ success: true, message: 'Message delete ho gaya!' });
}));

// ==========================================
// 404 + ERROR HANDLERS (sabse aakhir mein)
// ==========================================
app.use((req, res) => {
    res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
});

app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ success: false, message: 'Server error aaya hai.' });
});

// ==========================================
// SERVER START
// ==========================================
app.listen(PORT, () => {
    console.log(`GENRO Server is running on port ${PORT}`);
});

module.exports = app;
