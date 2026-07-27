const express = require('express');
const bcrypt = require('bcryptjs'); // Password hashing ke liye
const cors = require('cors');
const mysql = require('mysql2');
const path = require('path');
const fsPromises = require('fs').promises;
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

app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));

// Static hosting for chapter-level test question banks (e.g. files friends/
// content-writers hand over, like chemical_kinetics.json or gravitation.json).
// Drop any such JSON file into the test-content/ folder and it becomes
// reachable at https://<this-backend>/test-content/<filename>.json — that
// URL is exactly what goes into a chapter's or topic's test_json_url column.
app.use('/test-content', express.static(path.join(__dirname, 'test-content')));

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

const STUDY_TRACKS = ['Medical', 'Non-Medical'];

function normalizeStudyTrack(track) {
    const value = String(track || '').trim().toLowerCase().replace(/[\s_-]/g, '');
    return value === 'nonmedical' ? 'Non-Medical' : value === 'medical' ? 'Medical' : null;
}

function enrolledSubjectsForTrack(track) {
    return track === 'Non-Medical'
        ? JSON.stringify(['Physics', 'Chemistry', 'Maths'])
        : JSON.stringify(['Physics', 'Chemistry', 'Biology']);
}

async function addColumnIfMissing(tableName, columnName, definition) {
    const [columns] = await db.query(`SHOW COLUMNS FROM \`${tableName}\` LIKE ?`, [columnName]);
    if (!columns.length) await db.query(`ALTER TABLE \`${tableName}\` ADD COLUMN ${definition}`);
}

// Some columns (e.g. test_attempts.topic_id) were originally NOT NULL. Chapter
// and Custom practice attempts don't have a single topic, so this relaxes the
// column to NULL the first time the server boots with this update — a no-op
// on every boot after that.
async function makeColumnNullable(tableName, columnName, definition) {
    const [columns] = await db.query(`SHOW COLUMNS FROM \`${tableName}\` LIKE ?`, [columnName]);
    if (columns.length && columns[0].Null === 'NO') {
        await db.query(`ALTER TABLE \`${tableName}\` MODIFY COLUMN ${definition}`);
    }
}

// Existing deployments already have the original tables, so apply only additive
// changes at boot. A failed migration is logged but never hides the root cause
// by preventing the server from starting.
async function ensureDatabaseSchema() {
    await addColumnIfMissing('users', 'study_track', "study_track ENUM('Medical', 'Non-Medical') NOT NULL DEFAULT 'Medical' AFTER board");
    await addColumnIfMissing('ai_chat_history', 'attachment_data', 'attachment_data MEDIUMTEXT NULL AFTER message_text');
    await addColumnIfMissing('ai_chat_history', 'attachment_mime', 'attachment_mime VARCHAR(100) NULL AFTER attachment_data');

    // CUSTOM PRACTICE (difficulty): topics/chapters ke pehle se maujood
    // test_json_url ko "default" ki tarah rakha gaya hai. Agar in teen naye
    // columns mein se koi bhara hua hai, to us difficulty ke liye wahi URL
    // use hoga; khaali hone par default test_json_url par fallback hota hai
    // (isliye purana data turant break nahi hota).
    await addColumnIfMissing('topics', 'test_json_url_easy', 'test_json_url_easy VARCHAR(500) NULL AFTER test_json_url');
    await addColumnIfMissing('topics', 'test_json_url_medium', 'test_json_url_medium VARCHAR(500) NULL AFTER test_json_url_easy');
    await addColumnIfMissing('topics', 'test_json_url_hard', 'test_json_url_hard VARCHAR(500) NULL AFTER test_json_url_medium');
    await addColumnIfMissing('chapters', 'test_json_url_easy', 'test_json_url_easy VARCHAR(500) NULL AFTER test_json_url');
    await addColumnIfMissing('chapters', 'test_json_url_medium', 'test_json_url_medium VARCHAR(500) NULL AFTER test_json_url_easy');
    await addColumnIfMissing('chapters', 'test_json_url_hard', 'test_json_url_hard VARCHAR(500) NULL AFTER test_json_url_medium');

    await db.query(`CREATE TABLE IF NOT EXISTS test_attempts (
        attempt_id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        topic_id INT NOT NULL,
        status ENUM('Mastered', 'Revision Required') NOT NULL,
        accuracy_percentage DECIMAL(5,2) NOT NULL,
        xp_earned INT NOT NULL DEFAULT 0,
        attempted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_test_attempts_user_time (user_id, attempted_at),
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
        FOREIGN KEY (topic_id) REFERENCES topics(topic_id) ON DELETE CASCADE
    )`);
    await addColumnIfMissing('test_attempts', 'difficulty', "difficulty ENUM('Easy','Medium','Hard') NOT NULL DEFAULT 'Medium' AFTER topic_id");

    // PROGRESS FIX: Full-chapter tests and Custom Practice (multiple topics)
    // used to be silently skipped when saving progress, because this table
    // only ever accepted a single required topic_id. These columns let one
    // attempt row represent a topic test, a chapter test, or a custom mix.
    await makeColumnNullable('test_attempts', 'topic_id', 'topic_id INT NULL');
    await addColumnIfMissing('test_attempts', 'chapter_id', 'chapter_id INT NULL AFTER topic_id');
    await addColumnIfMissing('test_attempts', 'attempt_kind', "attempt_kind ENUM('Topic','Chapter','Custom') NOT NULL DEFAULT 'Topic' AFTER chapter_id");
    await addColumnIfMissing('test_attempts', 'label', 'label VARCHAR(255) NULL AFTER attempt_kind');
    await addColumnIfMissing('test_attempts', 'topic_ids_json', 'topic_ids_json JSON NULL AFTER label');

    // TEST REPORT: har question ka detail (kya poocha gaya, student ne kya
    // select kiya, sahi jawab kya tha) yahan save hota hai taaki baad mein
    // Progress page se poora review dobara dekha ja sake.
    await db.query(`CREATE TABLE IF NOT EXISTS test_attempt_answers (
        answer_id BIGINT AUTO_INCREMENT PRIMARY KEY,
        attempt_id BIGINT NOT NULL,
        question_number INT NOT NULL,
        question_text TEXT NOT NULL,
        options_json JSON NULL,
        selected_key VARCHAR(4) NULL,
        correct_key VARCHAR(4) NULL,
        is_correct TINYINT(1) NOT NULL DEFAULT 0,
        INDEX idx_test_attempt_answers_attempt (attempt_id),
        FOREIGN KEY (attempt_id) REFERENCES test_attempts(attempt_id) ON DELETE CASCADE
    )`);
}

// ==========================================
// 0. HEALTH CHECK (Render pings "/" — avoid a bare "Cannot GET /")
// ==========================================
app.get('/', (req, res) => {
    res.json({ success: true, message: 'GENRO Server is alive', build: 'study-track-debug-v1' });
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
        `SELECT c.chapter_id, c.chapter_number, c.chapter_name,
                c.test_json_url AS chapter_test_json_url,
                c.test_json_url_easy AS chapter_test_json_url_easy,
                c.test_json_url_medium AS chapter_test_json_url_medium,
                c.test_json_url_hard AS chapter_test_json_url_hard,
                t.topic_id, t.topic_sequence, t.topic_name, t.video_url,
                t.test_json_url AS topic_test_json_url,
                t.test_json_url_easy AS topic_test_json_url_easy,
                t.test_json_url_medium AS topic_test_json_url_medium,
                t.test_json_url_hard AS topic_test_json_url_hard
         FROM chapters c
         LEFT JOIN topics t ON c.chapter_id = t.chapter_id
         WHERE c.class_level = ? AND c.subject_name = ?
         ORDER BY c.chapter_number ASC, t.topic_sequence ASC`,
        [class_level, subject_name]
    );

    // Difficulty ke liye ek specific URL na ho to default test_json_url par
    // fallback — isse purana content bhi teeno difficulty buttons ke saath
    // turant kaam karta hai, naya content dheere-dheere specific bana sakte ho.
    const difficultyAvailability = (defaultUrl, easyUrl, mediumUrl, hardUrl) => ({
        easy: !!(easyUrl || defaultUrl),
        medium: !!(mediumUrl || defaultUrl),
        hard: !!(hardUrl || defaultUrl),
    });

    const chaptersMap = {};
    results.forEach(row => {
        if (!chaptersMap[row.chapter_id]) {
            chaptersMap[row.chapter_id] = {
                chapter_id: row.chapter_id,
                chapter_number: row.chapter_number,
                chapter_name: row.chapter_name,
                has_chapter_test: !!row.chapter_test_json_url,
                chapter_difficulty_available: difficultyAvailability(
                    row.chapter_test_json_url, row.chapter_test_json_url_easy,
                    row.chapter_test_json_url_medium, row.chapter_test_json_url_hard
                ),
                topics: []
            };
        }
        if (row.topic_id) {
            // CHAPTER-MASTER-FILE ENGINE: a topic counts as practicable either
            // with its own file, or by falling back to a live filtered slice
            // of its chapter's single master JSON file.
            const hasOwnTest = !!row.topic_test_json_url;
            const hasChapterFallback = !hasOwnTest && !!row.chapter_test_json_url;
            chaptersMap[row.chapter_id].topics.push({
                topic_id: row.topic_id,
                topic_sequence: row.topic_sequence,
                topic_name: row.topic_name,
                video_url: row.video_url || '',
                has_test: hasOwnTest || hasChapterFallback,
                from_chapter_bank: hasChapterFallback,
                difficulty_available: hasOwnTest
                    ? difficultyAvailability(
                        row.topic_test_json_url, row.topic_test_json_url_easy,
                        row.topic_test_json_url_medium, row.topic_test_json_url_hard
                      )
                    : { easy: hasChapterFallback, medium: hasChapterFallback, hard: hasChapterFallback },
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
    const { full_name, mobile_no, email, password, class_level, board, study_track } = req.body;
    const normalizedTrack = normalizeStudyTrack(study_track);

    if (!full_name || !mobile_no || !email || !password || !class_level || !board || !normalizedTrack) {
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
    const enrolledSubjects = enrolledSubjectsForTrack(normalizedTrack);

    try {
        const [result] = await db.query(
            `INSERT INTO users (full_name, mobile_no, email, password_hash, class_level, board, study_track, enrolled_subjects, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [full_name, mobile_no, email, hashedPassword, class_level, board, normalizedTrack, enrolledSubjects, formattedISTTime]
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
            study_track: user.study_track || 'Medical',
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
// ?difficulty=easy|medium|hard (optional, defaults to "medium"). Agar us
// difficulty ke liye alag JSON set nahi hai, to default test_json_url use
// hota hai — isliye purana content bhi bina kisi change ke chalta rehta hai.
function normalizeDifficulty(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return ['easy', 'medium', 'hard'].includes(normalized) ? normalized : 'medium';
}

function pickTestUrl(row, difficulty) {
    const columnMap = { easy: 'test_json_url_easy', medium: 'test_json_url_medium', hard: 'test_json_url_hard' };
    return row[columnMap[difficulty]] || row.test_json_url || null;
}

// ==========================================
// CHAPTER-MASTER-FILE ENGINE — serves a per-topic test straight out of a
// single "one JSON per chapter" file (all topics + all difficulties mixed
// together), with no per-topic file needed at all.
//
// This mirrors the same tolerant parsing the frontend already uses for
// question fields (normalizeQuestions in App.jsx) and additionally matches a
// question to a topic by trying several likely field names. If your content
// files use a different key for the topic name, add it to TOPIC_FIELD_KEYS
// below (or tell Claude the exact key and this list gets updated).
// ==========================================
// Some files tag a topic directly on each question ("topic": "..."); others
// (e.g. chapter -> sections[] -> {section, difficulties: {Easy: [...]}})
// nest questions under a parent object that carries the topic name instead.
// TOPIC_FIELD_KEYS covers both — "section"/"section_name" for the nested
// style, the rest for a direct per-question field.
const TOPIC_FIELD_KEYS = ['topic', 'topic_name', 'topicName', 'chapter_topic', 'sub_topic', 'subtopic', 'section', 'section_name'];
// Dict keys that mean "everything under here is this difficulty" even when
// no question itself carries a difficulty field, e.g. {"Easy": [...],
// "Medium": [...], "Tough": [...]}.
const DIFFICULTY_KEY_TOKENS = new Set(['easy', 'medium', 'hard', 'tough', 'difficult']);

function normalizeTopicLabel(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function directTopicField(question) {
    for (const key of TOPIC_FIELD_KEYS) {
        if (question[key]) return String(question[key]);
    }
    return '';
}

function questionTopicLabel(question) {
    return directTopicField(question) || question.__inheritedTopic || '';
}

// Recursively walks the JSON looking for anything with a question-text
// field, carrying down the nearest enclosing topic/section name and
// difficulty (from a dict key like "Easy") so a question nested inside
// grouped sections still knows which topic and difficulty it belongs to.
// Kept in sync with collectQuestionCandidates in App.jsx (frontend) and
// collect_question_candidates in tools/chapter_content_tool.py (Python).
function collectQuestionCandidates(value, currentTopic = '', currentDifficulty = '', candidates = [], depth = 0) {
    if (depth > 10) return candidates;
    if (Array.isArray(value)) {
        value.forEach((item) => collectQuestionCandidates(item, currentTopic, currentDifficulty, candidates, depth + 1));
        return candidates;
    }
    if (!value || typeof value !== 'object') return candidates;
    if (typeof value.question === 'string' || typeof value.question_text === 'string' || typeof value.text === 'string') {
        const question = { ...value };
        if (currentTopic && !directTopicField(question)) question.__inheritedTopic = currentTopic;
        if (currentDifficulty && !question.difficulty && !question.level) question.__inheritedDifficulty = currentDifficulty;
        candidates.push(question);
        return candidates;
    }
    let nextTopic = currentTopic;
    for (const key of TOPIC_FIELD_KEYS) {
        if (typeof value[key] === 'string') { nextTopic = value[key]; break; }
    }
    Object.entries(value).forEach(([key, item]) => {
        const nextDifficulty = DIFFICULTY_KEY_TOKENS.has(normalizeTopicLabel(key)) ? key : currentDifficulty;
        collectQuestionCandidates(item, nextTopic, nextDifficulty, candidates, depth + 1);
    });
    return candidates;
}

// Loads a chapter's master JSON. Files served from this app's own
// /test-content static folder are read straight off disk (fast, no self
// HTTP round trip); anything else is fetched over HTTP.
async function loadMasterChapterJson(testJsonUrl) {
    const localPrefix = '/test-content/';
    const localIndex = testJsonUrl.indexOf(localPrefix);
    if (localIndex !== -1) {
        const filename = decodeURIComponent(testJsonUrl.slice(localIndex + localPrefix.length).split(/[?#]/)[0]);
        const filePath = path.join(__dirname, 'test-content', filename);
        const raw = await fsPromises.readFile(filePath, 'utf8');
        return JSON.parse(raw);
    }
    const response = await fetch(testJsonUrl);
    if (!response.ok) throw new Error(`Master chapter file returned ${response.status}`);
    return response.json();
}

// Returns { questions, matchedTopics } — matchedTopics is every distinct
// topic label actually found tagged in the file, which the validator/admin
// tooling below uses to flag typos against the real topic list in the DB.
function filterQuestionsForTopic(masterPayload, topicName) {
    const root = masterPayload?.questions || masterPayload?.data || masterPayload;
    const allQuestions = collectQuestionCandidates(root);
    const wanted = normalizeTopicLabel(topicName);
    const matchedTopics = new Set();
    allQuestions.forEach((question) => {
        const label = questionTopicLabel(question);
        if (label) matchedTopics.add(label);
    });
    // If nothing in the file is topic-tagged at all, we can't safely split it
    // — treat the whole file as belonging to this topic rather than
    // returning an empty test.
    const anyTagged = allQuestions.some((question) => questionTopicLabel(question));
    const filtered = !anyTagged
        ? allQuestions
        : allQuestions.filter((question) => normalizeTopicLabel(questionTopicLabel(question)) === wanted);
    return { questions: filtered.length ? filtered : (anyTagged ? [] : allQuestions), matchedTopics: [...matchedTopics] };
}

app.get('/api/test/chapter/:chapter_id', ah(async (req, res) => {
    const { chapter_id } = req.params;
    const difficulty = normalizeDifficulty(req.query.difficulty);
    const [results] = await db.query(
        'SELECT chapter_id, chapter_name, test_json_url, test_json_url_easy, test_json_url_medium, test_json_url_hard FROM chapters WHERE chapter_id = ?',
        [chapter_id]
    );
    if (results.length === 0) {
        return res.status(404).json({ success: false, message: 'Chapter nahi mila!' });
    }
    const testJsonUrl = pickTestUrl(results[0], difficulty);
    if (!testJsonUrl) {
        return res.status(404).json({ success: false, message: 'Is chapter ke liye full test abhi available nahi hai.' });
    }
    res.status(200).json({
        success: true,
        data: { chapter_id: results[0].chapter_id, chapter_name: results[0].chapter_name, test_json_url: testJsonUrl, difficulty },
    });
}));

// Quick sanity check for a chapter's master file: which topic names does the
// file actually contain, and do they line up with the topics already in the
// database for that chapter? Handy to open in a browser right after
// uploading a new file, before students ever see it.
app.get('/api/admin/chapter/:chapter_id/bank-check', ah(async (req, res) => {
    const { chapter_id } = req.params;
    const [[chapter]] = await db.query('SELECT chapter_id, chapter_name, test_json_url FROM chapters WHERE chapter_id = ?', [chapter_id]);
    if (!chapter) return res.status(404).json({ success: false, message: 'Chapter nahi mila!' });
    if (!chapter.test_json_url) return res.status(400).json({ success: false, message: 'Is chapter ke liye abhi koi test_json_url set nahi hai.' });
    const [dbTopics] = await db.query('SELECT topic_id, topic_name FROM topics WHERE chapter_id = ? ORDER BY topic_sequence ASC', [chapter_id]);
    const masterPayload = await loadMasterChapterJson(chapter.test_json_url);
    const fileTopicLabels = new Set();
    collectQuestionCandidates(masterPayload?.questions || masterPayload?.data || masterPayload).forEach((question) => {
        const label = questionTopicLabel(question);
        if (label) fileTopicLabels.add(normalizeTopicLabel(label));
    });
    const perTopic = dbTopics.map((topic) => {
        const { questions } = filterQuestionsForTopic(masterPayload, topic.topic_name);
        return { topic_id: topic.topic_id, topic_name: topic.topic_name, questions_found: questions.length };
    });
    const unmatchedInFile = [...fileTopicLabels].filter((label) => !dbTopics.some((topic) => normalizeTopicLabel(topic.topic_name) === label));
    res.status(200).json({ success: true, data: { chapter_name: chapter.chapter_name, per_topic: perTopic, unmatched_labels_in_file: unmatchedInFile } });
}));

app.get('/api/test/:topic_id', ah(async (req, res) => {
    const { topic_id } = req.params;
    const difficulty = normalizeDifficulty(req.query.difficulty);
    const [results] = await db.query(
        `SELECT t.topic_id, t.topic_name, t.test_json_url, t.test_json_url_easy, t.test_json_url_medium, t.test_json_url_hard,
                c.test_json_url AS chapter_test_json_url
         FROM topics t JOIN chapters c ON t.chapter_id = c.chapter_id
         WHERE t.topic_id = ?`,
        [topic_id]
    );
    if (results.length === 0) {
        return res.status(404).json({ success: false, message: 'Topic nahi mila!' });
    }
    const topicRow = results[0];
    const directUrl = pickTestUrl(topicRow, difficulty);
    // CHAPTER-MASTER-FILE ENGINE: no dedicated file for this topic? If its
    // chapter has one "all topics in one JSON" file, serve a live,
    // topic-filtered slice of it instead of failing.
    const testJsonUrl = directUrl || (topicRow.chapter_test_json_url
        ? `/api/test-content/topic/${topicRow.topic_id}`
        : null);
    if (!testJsonUrl) {
        return res.status(404).json({ success: false, message: 'Is topic ke liye test abhi available nahi hai.' });
    }
    res.status(200).json({
        success: true,
        data: { topic_id: topicRow.topic_id, topic_name: topicRow.topic_name, test_json_url: testJsonUrl, difficulty },
    });
}));

// Live topic-filtered slice of a chapter's single master JSON file. Returned
// directly as the raw quiz payload (same shape as a static test-content
// file) since this is exactly what fetchQuizPayload() on the frontend expects
// — no frontend change needed for this to work.
app.get('/api/test-content/topic/:topic_id', ah(async (req, res) => {
    const { topic_id } = req.params;
    const [[topicRow]] = await db.query(
        `SELECT t.topic_id, t.topic_name, c.chapter_name, c.test_json_url AS chapter_test_json_url
         FROM topics t JOIN chapters c ON t.chapter_id = c.chapter_id
         WHERE t.topic_id = ?`,
        [topic_id]
    );
    if (!topicRow || !topicRow.chapter_test_json_url) {
        return res.status(404).json({ success: false, message: 'Is topic ke liye koi master chapter file nahi mili.' });
    }
    const masterPayload = await loadMasterChapterJson(topicRow.chapter_test_json_url);
    const { questions } = filterQuestionsForTopic(masterPayload, topicRow.topic_name);
    if (!questions.length) {
        return res.status(404).json({ success: false, message: `"${topicRow.topic_name}" ke liye is chapter file mein koi question tagged nahi mila.` });
    }
    res.status(200).json({ chapter_name: topicRow.chapter_name, topic_name: topicRow.topic_name, questions });
}));

// ==========================================
// 7. USER DASHBOARD API (GET)
// ==========================================
app.get('/api/user/:user_id/dashboard', ah(async (req, res) => {
    const { user_id } = req.params;
    const [results] = await db.query(
        `SELECT user_id, full_name, email, mobile_no, class_level, board, study_track, total_xp, day_streak, enrolled_subjects
         FROM users WHERE user_id = ?`,
        [user_id]
    );
    if (results.length === 0) {
        return res.status(404).json({ success: false, message: 'User nahi mila!' });
    }
    res.status(200).json({ success: true, data: results[0] });
}));

// ==========================================
// 8. UPDATE PROFILE API (PUT). Email and mobile are verified identity keys and
// deliberately never come from this route; changing either needs a dedicated
// OTP-protected account-recovery flow.
// ==========================================
app.put('/api/user/:user_id/profile', ah(async (req, res) => {
    const { user_id } = req.params;
    const { full_name, class_level, board, study_track } = req.body;
    const normalizedTrack = normalizeStudyTrack(study_track);

    // DEBUG: Render ke "Logs" tab mein ye line dikhegi. Isse pata chalega ki
    // frontend se kya value aa rahi hai aur normalize hone ke baad kya ban rahi hai.
    // Agar "normalizedTrack" yahan null aa raha hai, to isi wajah se save fail ho raha hai.
    console.log('[PROFILE UPDATE] incoming study_track:', JSON.stringify(study_track), '-> normalized:', normalizedTrack);

    if (!full_name || !normalizedTrack) {
        return res.status(400).json({
            success: false,
            message: 'Naam aur preparation track zaroori hain!',
            debug_received_study_track: study_track ?? null,
        });
    }

    try {
        const [result] = await db.query(
            `UPDATE users SET full_name = ?, class_level = COALESCE(?, class_level),
                board = COALESCE(?, board), study_track = ?, enrolled_subjects = ?
             WHERE user_id = ?`,
            [full_name, class_level || null, board || null, normalizedTrack, enrolledSubjectsForTrack(normalizedTrack), user_id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'User nahi mila!' });
        }
        const [[updatedUser]] = await db.query(
            'SELECT user_id, full_name, email, mobile_no, class_level, board, study_track, total_xp, day_streak FROM users WHERE user_id = ?',
            [user_id]
        );

        // DEBUG: DB se dobara padh kar confirm karta hai ki save actually ho gaya.
        console.log('[PROFILE UPDATE] saved study_track in DB now:', updatedUser.study_track);

        res.status(200).json({ success: true, message: 'Profile update ho gayi!', data: updatedUser });
    } catch (err) {
        throw err;
    }
}));

// ==========================================
// 9. UPDATE USER PROGRESS API (POST) — test complete hone ke baad
// ==========================================
app.post('/api/user/:user_id/progress', ah(async (req, res) => {
    const { user_id } = req.params;
    const { topic_id, chapter_id, topic_ids, label, accuracy_percentage, xp_earned, difficulty, answers } = req.body;
    const accuracy = Number(accuracy_percentage);
    const xp = Number(xp_earned);
    const normalizedDifficulty = ['Easy', 'Medium', 'Hard'].includes(difficulty) ? difficulty : 'Medium';
    // Report ke liye per-question answers (optional — purane frontend clients
    // jo ye array na bhejein unke liye bhi ye route bina toote kaam karta hai).
    const answerList = Array.isArray(answers) ? answers : [];

    // PROGRESS FIX: this route used to only accept a single topic_id, so any
    // full-chapter test or Custom Practice attempt (multiple topics) had
    // nowhere to be saved and silently vanished. It now accepts exactly one
    // of: topic_id (topic test), chapter_id (full chapter test), or
    // topic_ids (Custom Practice, an array of the topics that were mixed).
    const isCustom = Array.isArray(topic_ids) && topic_ids.length > 0;
    const isChapter = !isCustom && chapter_id;
    const isTopic = !isCustom && !isChapter && topic_id;

    if (!isTopic && !isChapter && !isCustom) {
        return res.status(400).json({ success: false, message: 'Topic, chapter, ya custom topic list dena zaroori hai.' });
    }
    if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100 || !Number.isFinite(xp) || xp < 0) {
        return res.status(400).json({ success: false, message: 'Valid accuracy aur XP dena zaroori hai.' });
    }
    const normalizedAccuracy = Math.round(accuracy * 100) / 100;
    const normalizedXp = Math.round(xp);
    const status = normalizedAccuracy >= 70 ? 'Mastered' : 'Revision Required';
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();
        let attemptKind = 'Topic';
        let attemptLabel = null;
        let savedTopicId = null;
        let savedChapterId = null;
        let topicIdsJson = null;

        if (isTopic) {
            const [[topic]] = await connection.query('SELECT topic_id FROM topics WHERE topic_id = ?', [topic_id]);
            if (!topic) {
                await connection.rollback();
                return res.status(404).json({ success: false, message: 'Topic nahi mila!' });
            }
            savedTopicId = topic_id;

            const [[existing]] = await connection.query(
                'SELECT progress_id FROM user_progress WHERE user_id = ? AND topic_id = ? FOR UPDATE',
                [user_id, topic_id]
            );

            if (existing) {
                await connection.query(
                    `UPDATE user_progress
                     SET status = ?, accuracy_percentage = ?, tests_attempted = tests_attempted + 1,
                         xp_earned = xp_earned + ?, last_tested_at = CURRENT_TIMESTAMP
                     WHERE progress_id = ?`,
                    [status, normalizedAccuracy, normalizedXp, existing.progress_id]
                );
            } else {
                await connection.query(
                    `INSERT INTO user_progress (user_id, topic_id, status, accuracy_percentage, tests_attempted, xp_earned)
                     VALUES (?, ?, ?, ?, 1, ?)`,
                    [user_id, topic_id, status, normalizedAccuracy, normalizedXp]
                );
            }
        } else if (isChapter) {
            const [[chapter]] = await connection.query('SELECT chapter_id, chapter_name FROM chapters WHERE chapter_id = ?', [chapter_id]);
            if (!chapter) {
                await connection.rollback();
                return res.status(404).json({ success: false, message: 'Chapter nahi mila!' });
            }
            savedChapterId = chapter_id;
            attemptKind = 'Chapter';
            attemptLabel = String(label || chapter.chapter_name || 'Full chapter test').slice(0, 255);
        } else {
            attemptKind = 'Custom';
            attemptLabel = String(label || `Custom practice · ${topic_ids.length} topics`).slice(0, 255);
            topicIdsJson = JSON.stringify(topic_ids.slice(0, 100));
        }

        const [attempt] = await connection.query(
            `INSERT INTO test_attempts (user_id, topic_id, chapter_id, attempt_kind, label, topic_ids_json, difficulty, status, accuracy_percentage, xp_earned)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [user_id, savedTopicId, savedChapterId, attemptKind, attemptLabel, topicIdsJson, normalizedDifficulty, status, normalizedAccuracy, normalizedXp]
        );

        // Report ke liye har question ki detail alag row mein save karo.
        if (answerList.length) {
            const answerRows = answerList.slice(0, 200).map((item, index) => [
                attempt.insertId,
                index + 1,
                String(item.question_text || item.text || '').slice(0, 2000),
                item.options ? JSON.stringify(item.options).slice(0, 4000) : null,
                item.selected_key ? String(item.selected_key).slice(0, 4) : null,
                item.correct_key ? String(item.correct_key).slice(0, 4) : null,
                item.is_correct ? 1 : 0,
            ]);
            await connection.query(
                `INSERT INTO test_attempt_answers
                 (attempt_id, question_number, question_text, options_json, selected_key, correct_key, is_correct)
                 VALUES ?`,
                [answerRows]
            );
        }

        const [userUpdate] = await connection.query('UPDATE users SET total_xp = total_xp + ? WHERE user_id = ?', [normalizedXp, user_id]);
        if (!userUpdate.affectedRows) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'User nahi mila!' });
        }
        const [[updatedUser]] = await connection.query('SELECT total_xp, day_streak FROM users WHERE user_id = ?', [user_id]);
        await connection.commit();

        res.status(200).json({
            success: true,
            message: 'Progress aur XP successfully update ho gaye!',
            data: { attempt_id: attempt.insertId, status, total_xp: updatedUser.total_xp, day_streak: updatedUser.day_streak }
        });
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}));

// ==========================================
// 9B. DETAILED TEST REPORT (GET) — ek attempt ke saare questions, student ka
//     jawab, aur sahi jawab wapas deta hai taaki Progress page se dobara
//     review kiya ja sake.
// ==========================================
app.get('/api/user/:user_id/attempts/:attempt_id/report', ah(async (req, res) => {
    const { user_id, attempt_id } = req.params;

    // LEFT JOINs (not JOIN) so Chapter and Custom attempts — which have no
    // single topic_id — still resolve to a row instead of vanishing; their
    // display name falls back to the saved label.
    const [[attempt]] = await db.query(
        `SELECT ta.attempt_id, ta.topic_id, ta.chapter_id, ta.attempt_kind, ta.label, ta.difficulty, ta.status,
                ta.accuracy_percentage, ta.xp_earned, ta.attempted_at,
                COALESCE(t.topic_name, ta.label, 'Practice test') AS topic_name,
                COALESCE(c.chapter_name, c2.chapter_name, '') AS chapter_name,
                COALESCE(c.subject_name, c2.subject_name, '') AS subject_name
         FROM test_attempts ta
         LEFT JOIN topics t ON ta.topic_id = t.topic_id
         LEFT JOIN chapters c ON t.chapter_id = c.chapter_id
         LEFT JOIN chapters c2 ON ta.chapter_id = c2.chapter_id
         WHERE ta.attempt_id = ? AND ta.user_id = ?`,
        [attempt_id, user_id]
    );
    if (!attempt) {
        return res.status(404).json({ success: false, message: 'Ye test report nahi mili!' });
    }

    const [answers] = await db.query(
        `SELECT question_number, question_text, options_json, selected_key, correct_key, is_correct
         FROM test_attempt_answers WHERE attempt_id = ? ORDER BY question_number ASC`,
        [attempt_id]
    );

    res.status(200).json({
        success: true,
        data: {
            ...attempt,
            answers: answers.map(row => ({
                ...row,
                options: row.options_json ? JSON.parse(row.options_json) : null,
                is_correct: !!row.is_correct,
            })),
            has_detailed_answers: answers.length > 0,
        },
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
    // PROGRESS FIX: LEFT JOINs so Chapter and Custom Practice attempts (no
    // single topic_id) still show up in test history instead of being
    // dropped by an inner JOIN that required one.
    const [testHistory] = await db.query(
        `SELECT ta.attempt_id, ta.topic_id, ta.chapter_id, ta.attempt_kind, ta.label, ta.difficulty, ta.status,
                ta.accuracy_percentage, ta.xp_earned, ta.attempted_at,
                COALESCE(t.topic_name, ta.label, 'Practice test') AS topic_name,
                COALESCE(c.chapter_id, c2.chapter_id) AS chapter_id_resolved,
                COALESCE(c.chapter_name, c2.chapter_name, '') AS chapter_name,
                COALESCE(c.subject_name, c2.subject_name, '') AS subject_name
         FROM test_attempts ta
         LEFT JOIN topics t ON ta.topic_id = t.topic_id
         LEFT JOIN chapters c ON t.chapter_id = c.chapter_id
         LEFT JOIN chapters c2 ON ta.chapter_id = c2.chapter_id
         WHERE ta.user_id = ?
         ORDER BY ta.attempted_at DESC, ta.attempt_id DESC`,
        [user_id]
    );

    const totalTests = testHistory.length || rows.reduce((sum, r) => sum + Number(r.tests_attempted || 0), 0);
    const avgAccuracy = testHistory.length
        ? testHistory.reduce((sum, r) => sum + Number(r.accuracy_percentage), 0) / testHistory.length
        : totalTests
            ? rows.reduce((sum, r) => sum + Number(r.accuracy_percentage) * Number(r.tests_attempted || 0), 0) / totalTests
            : 0;
    const revisionRequired = rows.filter(r => r.status === 'Revision Required' || Number(r.accuracy_percentage) < 70);
    const strongTopics = rows.filter(r => r.status === 'Mastered' || Number(r.accuracy_percentage) >= 70);

    res.status(200).json({
        success: true,
        data: {
            summary: {
                total_tests: totalTests,
                avg_accuracy: Math.round(avgAccuracy * 10) / 10,
                topics_covered: rows.length
            },
            strong_topics: strongTopics,
            revision_required: revisionRequired,
            // Kept for older frontend clients while the clearer field above rolls out.
            weak_topics: revisionRequired,
            all_progress: rows,
            test_history: testHistory
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
        `SELECT message_id, sender_type, message_text, created_at, attachment_mime,
                CASE WHEN attachment_data IS NOT NULL
                    THEN CONCAT('/api/chat/', user_id, '/', message_id, '/attachment')
                    ELSE NULL END AS attachment_url
         FROM ai_chat_history WHERE user_id = ? ORDER BY created_at ASC, message_id ASC`,
        [user_id]
    );
    res.status(200).json({ success: true, data: results });
}));

app.get('/api/chat/:user_id/:message_id/attachment', ah(async (req, res) => {
    const { user_id, message_id } = req.params;
    const [[attachment]] = await db.query(
        `SELECT attachment_data, attachment_mime FROM ai_chat_history
         WHERE user_id = ? AND message_id = ? AND attachment_data IS NOT NULL`,
        [user_id, message_id]
    );
    if (!attachment) return res.status(404).json({ success: false, message: 'Attachment nahi mila!' });
    res.set('Content-Type', attachment.attachment_mime || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(Buffer.from(attachment.attachment_data, 'base64'));
}));

// Accepts either a photo (JPG/PNG/WebP, sent from the camera button) or a
// document (PDF, sent from the document button) — both flow through the
// same attachment column, just tagged with their real mime type.
function sanitizeChatAttachment(rawAttachment) {
    if (!rawAttachment) return null;
    const match = String(rawAttachment.data_url || '').match(/^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!match) {
        const error = new Error('Attach a JPG, PNG, WebP photo or a PDF document.');
        error.status = 400;
        throw error;
    }
    const data = match[2].replace(/\s/g, '');
    if (Buffer.byteLength(data, 'base64') > 5 * 1024 * 1024) {
        const error = new Error('Attachment must be smaller than 5 MB.');
        error.status = 400;
        throw error;
    }
    return { mime: match[1].toLowerCase(), data };
}

// Very small rule-based tutor used when ANTHROPIC_API_KEY isn't configured, so
// the chat never breaks — it just isn't "smart" until you add a real key.
function fallbackAiReply(userText, hasAttachment = false) {
    const imageNote = hasAttachment ? ' Aapka attachment conversation mein securely save ho gaya hai. ' : ' ';
    return `Aapne poocha: "${userText}".${imageNote}Abhi is server par koi live AI model connect nahi hai — ` +
        `ANTHROPIC_API_KEY environment variable set karke real AI jawaab enable karein ` +
        `(dekhein server.js mein generateAiReply function). Tab tak, Study section mein jaakar ` +
        `related topic dhoondh kar concept video dekhein!`;
}

// Real AI reply via the Claude API — only runs if a key is configured. Swap
// ANTHROPIC_MODEL for any current Claude model string.
async function generateAiReply(userText, attachment = null) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return fallbackAiReply(userText, Boolean(attachment));

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
                messages: [{
                    role: 'user',
                    content: attachment
                        ? [
                            attachment.mime === 'application/pdf'
                                ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: attachment.data } }
                                : { type: 'image', source: { type: 'base64', media_type: attachment.mime, data: attachment.data } },
                            { type: 'text', text: userText }
                        ]
                        : userText
                }]
            })
        });

        if (!response.ok) throw new Error(`Anthropic API returned ${response.status}`);
        const data = await response.json();
        const text = data?.content?.find(block => block.type === 'text')?.text;
        return text || fallbackAiReply(userText, Boolean(attachment));
    } catch (err) {
        console.error('AI reply failed, using fallback:', err.message);
        return fallbackAiReply(userText, Boolean(attachment));
    }
}

// 11B. Naya message save karne ke liye (POST). Agar sender User hai, to server
// khud AI ka reply generate karke save bhi kar deta hai aur dono wapas bhejta
// hai — isse frontend ko doosri round-trip nahi karni padti.
app.post('/api/chat/:user_id', ah(async (req, res) => {
    const { user_id } = req.params;
    const { sender_type, message_text, attachment: rawAttachment } = req.body;
    const messageText = String(message_text || '').trim();

    if (sender_type !== 'User' || !messageText) {
        return res.status(400).json({ success: false, message: 'Sender Type aur Message dono zaroori hain!' });
    }
    const attachment = sanitizeChatAttachment(rawAttachment);

    const [userInsert] = await db.query(
        `INSERT INTO ai_chat_history (user_id, sender_type, message_text, attachment_data, attachment_mime)
         VALUES (?, ?, ?, ?, ?)`,
        [user_id, sender_type, messageText, attachment?.data || null, attachment?.mime || null]
    );

    const savedUserMessage = {
        message_id: userInsert.insertId,
        sender_type,
        message_text: messageText,
        attachment_url: attachment ? `/api/chat/${user_id}/${userInsert.insertId}/attachment` : null,
        attachment_mime: attachment?.mime || null,
    };

    const aiText = await generateAiReply(messageText, attachment);
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
        "UPDATE ai_chat_history SET message_text = ? WHERE message_id = ? AND user_id = ? AND sender_type = 'User'",
        [message_text.trim(), message_id, user_id]
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
        "DELETE FROM ai_chat_history WHERE message_id = ? AND user_id = ? AND sender_type = 'User'",
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
    res.status(err.status || 500).json({ success: false, message: err.status ? err.message : 'Server error aaya hai.' });
});

// ==========================================
// SERVER START
// ==========================================
ensureDatabaseSchema()
    .catch((error) => console.error('Database schema migration failed:', error.message))
    .finally(() => app.listen(PORT, () => {
        console.log(`GENRO Server is running on port ${PORT}`);
    }));

module.exports = app;
