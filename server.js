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
app.use(cors({
    origin: process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',').map(s => s.trim()) : '*'
}));

app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/test-content', express.static(path.join(__dirname, 'test-content')));

// ==========================================
// DATABASE CONNECTION (POOL)
// ==========================================
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

pool.query('SELECT 1', (err) => {
    if (err) {
        console.error('Database connection failed: ' + err.message);
        return;
    }
    console.log('Connected to MySQL Database successfully!');
});

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

async function makeColumnNullable(tableName, columnName, definition) {
    const [columns] = await db.query(`SHOW COLUMNS FROM \`${tableName}\` LIKE ?`, [columnName]);
    if (columns.length && columns[0].Null === 'NO') {
        await db.query(`ALTER TABLE \`${tableName}\` MODIFY COLUMN ${definition}`);
    }
}

async function ensureDatabaseSchema() {
    await addColumnIfMissing('users', 'study_track', "study_track ENUM('Medical', 'Non-Medical') NOT NULL DEFAULT 'Medical' AFTER board");
    await addColumnIfMissing('users', 'last_active_date', 'last_active_date DATE NULL AFTER day_streak');
    await addColumnIfMissing('ai_chat_history', 'attachment_data', 'attachment_data MEDIUMTEXT NULL AFTER message_text');
    await addColumnIfMissing('ai_chat_history', 'attachment_mime', 'attachment_mime VARCHAR(100) NULL AFTER attachment_data');
    await addColumnIfMissing('ai_chat_history', 'parent_message_id', 'parent_message_id INT NULL AFTER attachment_mime');
    
    await addColumnIfMissing('topics', 'test_json_url_easy', 'test_json_url_easy VARCHAR(500) NULL AFTER test_json_url');
    await addColumnIfMissing('topics', 'test_json_url_medium', 'test_json_url_medium VARCHAR(500) NULL AFTER test_json_url_easy');
    await addColumnIfMissing('topics', 'test_json_url_hard', 'test_json_url_hard VARCHAR(500) NULL AFTER test_json_url_medium');
    await addColumnIfMissing('chapters', 'test_json_url_easy', 'test_json_url_easy VARCHAR(500) NULL AFTER test_json_url');
    await addColumnIfMissing('chapters', 'test_json_url_medium', 'test_json_url_medium VARCHAR(500) NULL AFTER test_json_url_easy');
    await addColumnIfMissing('chapters', 'test_json_url_hard', 'test_json_url_hard VARCHAR(500) NULL AFTER test_json_url_medium');
    
    await db.query(`CREATE TABLE IF NOT EXISTS test_attempts (
        attempt_id   BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id      INT NOT NULL,
        topic_id     INT NULL,
        chapter_id   INT NULL,
        attempt_kind ENUM('Topic','Chapter','Custom') NOT NULL DEFAULT 'Topic',
        label        VARCHAR(255) NULL,
        topic_ids_json TEXT NULL,
        difficulty   ENUM('Easy','Medium','Hard') NOT NULL DEFAULT 'Medium',
        status       ENUM('Mastered','Revision Required') NOT NULL,
        accuracy_percentage DECIMAL(5,2) NOT NULL,
        xp_earned    INT NOT NULL DEFAULT 0,
        attempted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_test_attempts_user_time (user_id, attempted_at),
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    )`);

    await makeColumnNullable('test_attempts', 'topic_id', 'topic_id INT NULL');
    await addColumnIfMissing('test_attempts', 'difficulty',      "difficulty ENUM('Easy','Medium','Hard') NOT NULL DEFAULT 'Medium' AFTER topic_id");
    await addColumnIfMissing('test_attempts', 'chapter_id',      'chapter_id INT NULL AFTER topic_id');
    await addColumnIfMissing('test_attempts', 'attempt_kind',    "attempt_kind ENUM('Topic','Chapter','Custom') NOT NULL DEFAULT 'Topic' AFTER chapter_id");
    await addColumnIfMissing('test_attempts', 'label',           'label VARCHAR(255) NULL AFTER attempt_kind');
    await addColumnIfMissing('test_attempts', 'topic_ids_json',  'topic_ids_json TEXT NULL AFTER label');

    await db.query(`CREATE TABLE IF NOT EXISTS test_attempt_answers (
        answer_id       BIGINT AUTO_INCREMENT PRIMARY KEY,
        attempt_id      BIGINT NOT NULL,
        question_number INT NOT NULL,
        question_text   TEXT NOT NULL,
        topic_name      VARCHAR(255) NULL,
        options_json    TEXT NULL,
        selected_key    VARCHAR(4) NULL,
        correct_key     VARCHAR(4) NULL,
        is_correct      TINYINT(1) NOT NULL DEFAULT 0,
        INDEX idx_test_attempt_answers_attempt (attempt_id),
        FOREIGN KEY (attempt_id) REFERENCES test_attempts(attempt_id) ON DELETE CASCADE
    )`);
    await addColumnIfMissing('test_attempt_answers', 'topic_name', 'topic_name VARCHAR(255) NULL AFTER question_text');
}

// ==========================================
// 0. HEALTH CHECK
// ==========================================
app.get('/', (req, res) => {
    res.json({ success: true, message: 'GENRO Server is alive', build: 'topic_ids_json-fix-v3' });
});

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
// 2. SYLLABUS API
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
                has_chapter_test: !!(row.chapter_test_json_url || row.chapter_test_json_url_easy || row.chapter_test_json_url_medium || row.chapter_test_json_url_hard),
                chapter_difficulty_available: difficultyAvailability(
                    row.chapter_test_json_url, row.chapter_test_json_url_easy,
                    row.chapter_test_json_url_medium, row.chapter_test_json_url_hard
                ),
                topics: []
            };
        }
        if (row.topic_id) {
            const hasOwnTest = !!(row.topic_test_json_url || row.topic_test_json_url_easy || row.topic_test_json_url_medium || row.topic_test_json_url_hard);
            const hasChapterFallback = !hasOwnTest && !!(row.chapter_test_json_url || row.chapter_test_json_url_easy || row.chapter_test_json_url_medium || row.chapter_test_json_url_hard);
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
// 3. OTP APIS
// ==========================================
const otpStore = new Map();
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_DEMO_MODE = process.env.OTP_DEMO_MODE !== 'false';

function generateOtp() {
    return String(Math.floor(1000 + Math.random() * 9000));
}

async function sendSms(mobile_no, otp) {
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
// 4. USER SIGNUP API
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

        otpStore.delete(mobile_no);

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
// 5. USER LOGIN API
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
// 6. FETCH TEST JSON URL APIS
// ==========================================
function normalizeDifficulty(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'all') return 'all';
    return canonicalDifficulty(normalized) || 'medium';
}

function pickTestUrl(row, difficulty) {
    const columnMap = { easy: 'test_json_url_easy', medium: 'test_json_url_medium', hard: 'test_json_url_hard' };
    return row[columnMap[difficulty]] || row.test_json_url || null;
}

const TOPIC_FIELD_KEYS = ['topic', 'topic_name', 'topicName', 'chapter_topic', 'sub_topic', 'subtopic', 'section', 'section_name', 'sectionTitle', 'unit', 'unit_name', 'lesson', 'concept'];
const DIFFICULTY_KEY_TOKENS = new Set(['easy', 'medium', 'moderate', 'hard', 'tough', 'difficult', 'advanced', 'basic']);

function canonicalDifficulty(value) {
    const label = normalizeTopicLabel(value);
    if (['hard', 'tough', 'difficult', 'advanced'].includes(label)) return 'hard';
    if (['medium', 'moderate'].includes(label)) return 'medium';
    if (['easy', 'basic'].includes(label)) return 'easy';
    return '';
}

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

function collectQuestionCandidates(value, currentTopic = '', currentDifficulty = '', candidates = [], depth = 0, seen = new WeakSet()) {
    if (depth > 40 || !value || typeof value !== 'object') return candidates;
    if (seen.has(value)) return candidates;
    seen.add(value);
    if (Array.isArray(value)) {
        value.forEach((item) => collectQuestionCandidates(item, currentTopic, currentDifficulty, candidates, depth + 1, seen));
        return candidates;
    }
    const text = value.question || value.question_text || value.questionText || value.prompt || value.stem || value.text;
    const hasOptions = value.options || value.answers || value.choices || value.option || value.mcq_options;
    if (typeof text === 'string' && (hasOptions || value.correct_answer || value.answer || value.correctOption || value.correct_option)) {
        const question = { ...value };
        if (currentTopic && !directTopicField(question)) question.__inheritedTopic = currentTopic;
        if (currentDifficulty && !question.difficulty && !question.level) question.difficulty = currentDifficulty;
        candidates.push(question);
        return candidates;
    }
    let nextTopic = currentTopic;
    for (const key of TOPIC_FIELD_KEYS) {
        if (typeof value[key] === 'string') { nextTopic = value[key]; break; }
    }
    Object.entries(value).forEach(([key, item]) => {
        const normKey = normalizeTopicLabel(key);
        const isDifficulty = DIFFICULTY_KEY_TOKENS.has(normKey);
        const nextDifficulty = isDifficulty ? key : currentDifficulty;
        
        let passTopic = nextTopic;
        const isStructural = ['questions', 'data', 'biology', 'physics', 'chemistry', 'maths', 'botany', 'zoology'].includes(normKey);
        if (!isDifficulty && !isStructural && typeof item === 'object' && isNaN(Number(key))) {
            passTopic = key;
        }
        
        collectQuestionCandidates(item, passTopic, nextDifficulty, candidates, depth + 1, seen);
    });
    return candidates;
}

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

function filterQuestionsForTopic(masterPayload, topicName, difficulty) {
    const root = masterPayload?.questions || masterPayload?.data || masterPayload;
    const allQuestions = collectQuestionCandidates(root);
    const wanted = normalizeTopicLabel(topicName);
    const matchedTopics = new Set();
    allQuestions.forEach((question) => {
        const label = questionTopicLabel(question);
        if (label) matchedTopics.add(label);
    });
    const anyTagged = allQuestions.some((question) => questionTopicLabel(question));
    let filtered = !anyTagged
        ? allQuestions
        : allQuestions.filter((question) => normalizeTopicLabel(questionTopicLabel(question)) === wanted);
    filtered = filtered.length ? filtered : (anyTagged ? [] : allQuestions);

    if (difficulty && difficulty !== 'all') {
        const wantedDifficulty = canonicalDifficulty(difficulty);
        const withDifficulty = filtered.filter((question) => canonicalDifficulty(question.difficulty || question.level || '') === wantedDifficulty);
        if (withDifficulty.length) filtered = withDifficulty;
    }

    return { questions: filtered, matchedTopics: [...matchedTopics] };
}

function sampleQuestions(questions, limit = 20) {
    const copy = [...questions];
    for (let index = copy.length - 1; index > 0; index -= 1) {
        const randomIndex = Math.floor(Math.random() * (index + 1));
        [copy[index], copy[randomIndex]] = [copy[randomIndex], copy[index]];
    }
    return copy.slice(0, limit);
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
    const testJsonUrl = results[0].test_json_url
        ? `/api/test-content/chapter/${chapter_id}?difficulty=${encodeURIComponent(difficulty)}`
        : pickTestUrl(results[0], difficulty);
    if (!testJsonUrl) {
        return res.status(404).json({ success: false, message: 'Is chapter ke liye full test abhi available nahi hai.' });
    }
    res.status(200).json({
        success: true,
        data: { chapter_id: results[0].chapter_id, chapter_name: results[0].chapter_name, test_json_url: testJsonUrl, difficulty },
    });
}));

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
    const testJsonUrl = topicRow.chapter_test_json_url
        ? `/api/test-content/topic/${topicRow.topic_id}?difficulty=${encodeURIComponent(difficulty)}`
        : directUrl;
    if (!testJsonUrl) {
        return res.status(404).json({ success: false, message: 'Is topic ke liye test abhi available nahi hai.' });
    }
    res.status(200).json({
        success: true,
        data: { topic_id: topicRow.topic_id, topic_name: topicRow.topic_name, test_json_url: testJsonUrl, difficulty },
    });
}));

app.get('/api/test-content/topic/:topic_id', ah(async (req, res) => {
    const { topic_id } = req.params;
    const difficulty = String(req.query.difficulty || 'medium').toLowerCase();
    const [[topicRow]] = await db.query(
        `SELECT t.topic_id, t.topic_name, t.test_json_url, t.test_json_url_easy, t.test_json_url_medium, t.test_json_url_hard, c.chapter_name, c.test_json_url AS chapter_test_json_url
         FROM topics t JOIN chapters c ON t.chapter_id = c.chapter_id
         WHERE t.topic_id = ?`,
        [topic_id]
    );

    const urlToTry =
        (difficulty === 'easy' ? topicRow?.test_json_url_easy :
         difficulty === 'hard' ? topicRow?.test_json_url_hard :
         topicRow?.test_json_url_medium)
        || topicRow?.test_json_url
        || topicRow?.chapter_test_json_url;

    if (!topicRow || !urlToTry) {
        return res.status(404).json({ success: false, message: 'Is topic ke liye koi test file nahi mili.' });
    }
    const masterPayload = await loadMasterChapterJson(urlToTry);
    const { questions } = filterQuestionsForTopic(masterPayload, topicRow.topic_name, difficulty);
    if (!questions.length) {
        return res.status(404).json({ success: false, message: `"${topicRow.topic_name}" ke liye is chapter file mein koi question tagged nahi mila.` });
    }
    res.status(200).json({ chapter_name: topicRow.chapter_name, topic_name: topicRow.topic_name, questions: sampleQuestions(questions) });
}));

// ==========================================
// 7. USER DASHBOARD API
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
// 8. UPDATE PROFILE API
// ==========================================
app.put('/api/user/:user_id/profile', ah(async (req, res) => {
    const { user_id } = req.params;
    const { full_name, class_level, board, study_track } = req.body;
    const normalizedTrack = normalizeStudyTrack(study_track);

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

        console.log('[PROFILE UPDATE] saved study_track in DB now:', updatedUser.study_track);

        res.status(200).json({ success: true, message: 'Profile update ho gayi!', data: updatedUser });
    } catch (err) {
        throw err;
    }
}));

// ==========================================
// 9. UPDATE USER PROGRESS API
// ==========================================
app.post('/api/user/:user_id/progress', ah(async (req, res) => {
    const { user_id } = req.params;
    const { topic_id, chapter_id, topic_ids, label, accuracy_percentage, xp_earned, difficulty, answers } = req.body;
    
    const accuracy = Number(accuracy_percentage);
    const xp = Number(xp_earned);
    const normalizedDifficulty = ({ easy: 'Easy', medium: 'Medium', hard: 'Hard' })[canonicalDifficulty(difficulty)] || 'Medium';

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
    const answerList = Array.isArray(answers) ? answers : [];

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();
        let attemptKind = 'Topic';
        let attemptLabel = null;
        let savedTopicId = null;
        let savedChapterId = null;
        let topicIdsJson = null;
        let progressTopicIds = [];

        if (isTopic) {
            const [[topic]] = await connection.query('SELECT topic_id FROM topics WHERE topic_id = ?', [topic_id]);
            if (!topic) {
                await connection.rollback();
                return res.status(404).json({ success: false, message: 'Topic nahi mila!' });
            }
            savedTopicId = topic_id;
            progressTopicIds = [Number(topic_id)];
        } else if (isChapter) {
            const [[chapter]] = await connection.query('SELECT chapter_id, chapter_name FROM chapters WHERE chapter_id = ?', [chapter_id]);
            if (!chapter) {
                await connection.rollback();
                return res.status(404).json({ success: false, message: 'Chapter nahi mila!' });
            }
            savedChapterId = chapter_id;
            const [chapterTopics] = await connection.query('SELECT topic_id FROM topics WHERE chapter_id = ?', [chapter_id]);
            progressTopicIds = chapterTopics.map(row => Number(row.topic_id));
            attemptKind = 'Chapter';
            attemptLabel = String(label || chapter.chapter_name || 'Full chapter test').slice(0, 255);
        } else {
            attemptKind = 'Custom';
            attemptLabel = String(label || `Custom practice · ${topic_ids.length} topics`).slice(0, 255);
            topicIdsJson = JSON.stringify(topic_ids.slice(0, 100));
            const [validTopics] = await connection.query(
                `SELECT topic_id FROM topics WHERE topic_id IN (${topic_ids.map(() => '?').join(',')})`, topic_ids
            );
            progressTopicIds = validTopics.map(row => Number(row.topic_id));
        }

        const [attempt] = await connection.query(
            `INSERT INTO test_attempts (user_id, topic_id, chapter_id, attempt_kind, label, topic_ids_json, difficulty, status, accuracy_percentage, xp_earned, attempted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [user_id, savedTopicId, savedChapterId, attemptKind, attemptLabel, topicIdsJson, normalizedDifficulty, status, normalizedAccuracy, normalizedXp, new Date()]
        );

        if (progressTopicIds.length > 0) {
            const xpPerTopic = Math.round(normalizedXp / Math.max(progressTopicIds.length, 1));
            for (const pid of progressTopicIds) {
                const [[existing]] = await connection.query(
                    'SELECT progress_id FROM user_progress WHERE user_id = ? AND topic_id = ? FOR UPDATE',
                    [user_id, pid]
                );
                if (existing) {
                    await connection.query(
                        `UPDATE user_progress
                         SET status = ?, accuracy_percentage = ?, tests_attempted = tests_attempted + 1,
                             xp_earned = xp_earned + ?, last_tested_at = CURRENT_TIMESTAMP
                         WHERE progress_id = ?`,
                        [status, normalizedAccuracy, xpPerTopic, existing.progress_id]
                    );
                } else {
                    await connection.query(
                        `INSERT INTO user_progress (user_id, topic_id, status, accuracy_percentage, tests_attempted, xp_earned)
                         VALUES (?, ?, ?, ?, 1, ?)`,
                        [user_id, pid, status, normalizedAccuracy, xpPerTopic]
                    );
                }
            }
        }

        let detailedAnswersSaved = false;
        if (answerList.length) {
            const answerRows = answerList.slice(0, 200).map((item, index) => [
                attempt.insertId,
                index + 1,
                String(item.question_text || item.text || '').slice(0, 2000),
                String(item.topic_name || item.topic || item.section || '').slice(0, 255) || null,
                item.options ? JSON.stringify(item.options) : null,
                item.selected_key ? String(item.selected_key).slice(0, 4) : null,
                item.correct_key ? String(item.correct_key).slice(0, 4) : null,
                item.is_correct ? 1 : 0,
            ]);
            try {
                await connection.query(
                    `INSERT INTO test_attempt_answers
                     (attempt_id, question_number, question_text, topic_name, options_json, selected_key, correct_key, is_correct)
                     VALUES ?`,
                    [answerRows]
                );
                detailedAnswersSaved = true;
            } catch (answerError) {
                console.error('Detailed answer save failed:', answerError.message);
                const legacyRows = answerRows.map(([attemptId, number, text, _topic, options, selected, correct, isCorrect]) => [
                    attemptId, number, text, options, selected, correct, isCorrect
                ]);
                try {
                    await connection.query(
                        `INSERT INTO test_attempt_answers
                         (attempt_id, question_number, question_text, options_json, selected_key, correct_key, is_correct)
                         VALUES ?`,
                        [legacyRows]
                    );
                    detailedAnswersSaved = true;
                } catch (legacyError) {
                    console.error('Legacy detailed answer save failed:', legacyError.message);
                }
            }
        }

        const [userUpdate] = await connection.query(
            `UPDATE users 
             SET total_xp = total_xp + ?,
                 day_streak = CASE 
                    WHEN last_active_date IS NULL THEN 1
                    WHEN DATEDIFF(CURRENT_DATE, last_active_date) = 1 THEN day_streak + 1
                    WHEN DATEDIFF(CURRENT_DATE, last_active_date) > 1 THEN 1
                    ELSE GREATEST(day_streak, 1)
                 END,
                 last_active_date = CURRENT_DATE
             WHERE user_id = ?`,
            [normalizedXp, user_id]
        );
        if (!userUpdate.affectedRows) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'User nahi mila!' });
        }
        const [[updatedUser]] = await connection.query('SELECT total_xp, day_streak FROM users WHERE user_id = ?', [user_id]);
        
        await connection.commit();

        res.status(200).json({
            success: true,
            message: 'Progress aur XP successfully update ho gaye!',
            data: { attempt_id: attempt.insertId, status, detailed_answers_saved: detailedAnswersSaved, total_xp: updatedUser.total_xp, day_streak: updatedUser.day_streak }
        });
    } catch (error) {
        await connection.rollback();
        error.status = error.status || 500;
        error.message = `Progress could not be saved: ${error.message}`;
        throw error;
    } finally {
        connection.release();
    }
}));

// ==========================================
// 9B. DETAILED TEST REPORT
// ==========================================
app.get('/api/user/:user_id/attempts/:attempt_id/report', ah(async (req, res) => {
    const { user_id, attempt_id } = req.params;

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
        `SELECT question_number, question_text, topic_name, options_json, selected_key, correct_key, is_correct
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
// 10. GET FULL PROGRESS LIST
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
            weak_topics: revisionRequired,
            all_progress: rows,
            test_history: testHistory
        }
    });
}));

// ==========================================
// 11. AI CHAT HISTORY API
// ==========================================
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
function fallbackAiReply(userText, hasAttachment = false) {
    const imageNote = hasAttachment ? ' Aapka attachment conversation mein securely save ho gaya hai. ' : ' ';
    return `Aapne poocha: "${userText}".${imageNote}Abhi is server par koi live AI model connect nahi hai - ` +
        `GEMINI_API_KEY environment variable set karke real AI jawaab enable karein ` +
        `(dekhein server.js mein generateAiReply function). Tab tak, Study section mein jaakar ` +
        `related topic dhoondh kar concept video dekhein!`;
}

async function generateAiReply(userText, attachment = null, userName = "Student", history = [], userStats = null, recentTests = []) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return fallbackAiReply(userText, Boolean(attachment));

    try {
        const contents = history.map(msg => ({
            role: msg.sender_type === 'User' ? 'user' : 'model',
            parts: [{ text: msg.message_text }]
        }));

        const currentParts = [{ text: userText }];
        if (attachment) {
            currentParts.unshift({
                inline_data: {
                    mime_type: attachment.mime,
                    data: attachment.data
                }
            });
        }
        contents.push({ role: 'user', parts: currentParts });

        let statsContext = "";
        if (userStats) {
            statsContext = `\n\nStudent Profile:\nClass: ${userStats.class_level || 'N/A'}\nBoard: ${userStats.board || 'N/A'}\nStudy Streak: ${userStats.day_streak || 0} days\nXP: ${userStats.total_xp || 0} XP`;
        }
        
        if (recentTests && recentTests.length > 0) {
            statsContext += `\nRecent Tests Performance:`;
            recentTests.forEach(test => {
                statsContext += `\n- Topic: ${test.label}, Accuracy: ${test.accuracy_percentage}%, Status: ${test.status}`;
            });
        }

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents,
                system_instruction: {
                    parts: [{
                        text: `You are Genro AI, a friendly, funny, and encouraging study buddy for Indian Class 11-12 students preparing for NEET and board exams (Physics, Chemistry, Maths, Biology). The student you are talking to is named ${userName}. Use their name occasionally to be friendly.

CRITICAL RULES:
1. ONLY answer questions related to study topics (Physics, Chemistry, Maths, Biology). If the user asks about anything else, politely decline and say: "Sorry, I can't answer problems related to this. Let's get back to your syllabus!"
2. Explain every topic in a highly entertaining, funny, and extremely easy-to-understand way. Use real-life relatable examples, jokes, or any creative method necessary to ensure the user grasps the concept easily.
3. ALWAYS match the user's language. If the user asks the question purely in English, reply completely in English. If the user uses Hindi or Hinglish, reply in a mix of Hindi and English (Hinglish). Keep answers focused and exam-relevant.
4. At the end of EVERY explanation, ALWAYS ask the user if they understood, and offer to explain it in a different way if they didn't. (For example: "Batao, samajh aaya ya upar se gaya? Agar samajh nahi aaya toh mujhe batao, main kisi doosre tareeke se samjhata hu!").${statsContext}`
                    }]
                },
                generationConfig: { maxOutputTokens: 1500 }
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Gemini API returned ${response.status}: ${errorText}`);
        }
        
        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        return text || fallbackAiReply(userText, Boolean(attachment));
    } catch (err) {
        console.error('AI reply failed, using fallback:', err.message);
        return fallbackAiReply(userText, Boolean(attachment));
    }
}

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

    const [[user]] = await db.query("SELECT full_name, class_level, board, day_streak, total_xp FROM users WHERE user_id = ?", [user_id]);
    const userName = user?.full_name?.split(' ')[0] || "Student";

    const [history] = await db.query(
        "SELECT sender_type, message_text FROM (SELECT sender_type, message_text, created_at FROM ai_chat_history WHERE user_id = ? ORDER BY message_id DESC LIMIT 30) sub ORDER BY created_at ASC",
        [user_id]
    );

    const [recentTests] = await db.query(
        "SELECT label, accuracy_percentage, status FROM test_attempts WHERE user_id = ? ORDER BY attempted_at DESC LIMIT 3",
        [user_id]
    );

    const aiText = await generateAiReply(messageText, attachment, userName, history, user, recentTests);
    const [aiInsert] = await db.query(
        "INSERT INTO ai_chat_history (user_id, sender_type, message_text, parent_message_id) VALUES (?, 'Genro_AI', ?, ?)",
        [user_id, aiText, userInsert.insertId]
    );
    const savedAiMessage = { message_id: aiInsert.insertId, sender_type: 'Genro_AI', message_text: aiText };

    res.status(201).json({
        success: true,
        message: 'Message successfully saved in history!',
        data: { user_message: savedUserMessage, ai_message: savedAiMessage }
    });
}));

app.put('/api/chat/:user_id/:message_id', ah(async (req, res) => {
    const { user_id, message_id } = req.params;
    const { message_text } = req.body;

    if (!message_text || !message_text.trim()) {
        return res.status(400).json({ success: false, message: 'Message khali nahi ho sakta!' });
    }

    const [[userMessage]] = await db.query(
        "SELECT attachment_data, attachment_mime FROM ai_chat_history WHERE message_id = ? AND user_id = ? AND sender_type = 'User'",
        [message_id, user_id]
    );
    if (!userMessage) {
        return res.status(404).json({ success: false, message: 'Message nahi mila!' });
    }
    const text = message_text.trim();
    await db.query("UPDATE ai_chat_history SET message_text = ? WHERE message_id = ?", [text, message_id]);

    await db.query(
        "DELETE FROM ai_chat_history WHERE user_id = ? AND sender_type = 'Genro_AI' AND parent_message_id = ?",
        [user_id, message_id]
    );
    const [[nextUser]] = await db.query(
        "SELECT MIN(message_id) AS message_id FROM ai_chat_history WHERE user_id = ? AND sender_type = 'User' AND message_id > ?",
        [user_id, message_id]
    );
    if (nextUser?.message_id) {
        await db.query(
            "DELETE FROM ai_chat_history WHERE user_id = ? AND sender_type = 'Genro_AI' AND parent_message_id IS NULL AND message_id > ? AND message_id < ?",
            [user_id, message_id, nextUser.message_id]
        );
    } else {
        await db.query(
            "DELETE FROM ai_chat_history WHERE user_id = ? AND sender_type = 'Genro_AI' AND parent_message_id IS NULL AND message_id > ?",
            [user_id, message_id]
        );
    }

    const attachment = userMessage.attachment_data
        ? { data: userMessage.attachment_data, mime: userMessage.attachment_mime || 'image/jpeg' }
        : null;

    const [[user]] = await db.query("SELECT full_name, class_level, board, day_streak, total_xp FROM users WHERE user_id = ?", [user_id]);
    const userName = user?.full_name?.split(' ')[0] || "Student";

    const [history] = await db.query(
        "SELECT sender_type, message_text FROM (SELECT sender_type, message_text, created_at FROM ai_chat_history WHERE user_id = ? AND message_id < ? ORDER BY message_id DESC LIMIT 30) sub ORDER BY created_at ASC",
        [user_id, message_id]
    );

    const [recentTests] = await db.query(
        "SELECT label, accuracy_percentage, status FROM test_attempts WHERE user_id = ? ORDER BY attempted_at DESC LIMIT 3",
        [user_id]
    );

    const aiText = await generateAiReply(text, attachment, userName, history, user, recentTests);
    const [insert] = await db.query(
        "INSERT INTO ai_chat_history (user_id, sender_type, message_text, parent_message_id) VALUES (?, 'Genro_AI', ?, ?)",
        [user_id, aiText, message_id]
    );
    const aiMessageId = insert.insertId;
    res.status(200).json({
        success: true,
        message: 'Message aur Genro AI ka fresh reply update ho gaya!',
        data: {
            user_message: { message_id: Number(message_id), sender_type: 'User', message_text: text },
            ai_message: { message_id: aiMessageId, sender_type: 'Genro_AI', message_text: aiText, parent_message_id: Number(message_id) }
        }
    });
}));

app.get('/api/test-content/chapter/:chapter_id', ah(async (req, res) => {
    const difficulty = normalizeDifficulty(req.query.difficulty);
    const [[chapter]] = await db.query('SELECT chapter_name, test_json_url, test_json_url_easy, test_json_url_medium, test_json_url_hard FROM chapters WHERE chapter_id = ?', [req.params.chapter_id]);
    
    const urlToTry =
        (difficulty === 'easy' ? chapter?.test_json_url_easy :
         difficulty === 'hard' ? chapter?.test_json_url_hard :
         chapter?.test_json_url_medium)
        || chapter?.test_json_url;

    if (!urlToTry) return res.status(404).json({ success: false, message: 'Chapter test source not found.' });
    const payload = await loadMasterChapterJson(urlToTry);
    let questions = collectQuestionCandidates(payload?.questions || payload?.data || payload);
    if (difficulty !== 'all') {
        const tagged = questions.filter(question => canonicalDifficulty(question.difficulty || question.level) === canonicalDifficulty(difficulty));
        if (tagged.length) questions = tagged;
    }
    res.json({ chapter_name: chapter.chapter_name, questions: sampleQuestions(questions) });
}));

app.post('/api/test/custom', ah(async (req, res) => {
    const topicIds = [...new Set((Array.isArray(req.body.topic_ids) ? req.body.topic_ids : [])
        .map(Number).filter(Number.isInteger))].slice(0, 100);
    const difficulty = normalizeDifficulty(req.body.difficulty);
    if (!topicIds.length) return res.status(400).json({ success: false, message: 'At least one topic is required.' });
    const placeholders = topicIds.map(() => '?').join(',');
    const [topics] = await db.query(
        `SELECT t.topic_id, t.topic_name, t.test_json_url, t.test_json_url_easy, t.test_json_url_medium, t.test_json_url_hard,
                c.test_json_url AS chapter_test_json_url
         FROM topics t JOIN chapters c ON c.chapter_id = t.chapter_id WHERE t.topic_id IN (${placeholders})`,
        topicIds
    );
    const byId = new Map(topics.map(topic => [Number(topic.topic_id), topic]));
    const questionSets = await Promise.all(topicIds.map(async (topicId) => {
        const topic = byId.get(topicId);
        if (!topic) return [];
        const url = pickTestUrl(topic, difficulty);
        try {
            const payload = topic.chapter_test_json_url
                ? await loadMasterChapterJson(topic.chapter_test_json_url)
                : await loadMasterChapterJson(url);
            const questions = topic.chapter_test_json_url
                ? filterQuestionsForTopic(payload, topic.topic_name, difficulty).questions
                : collectQuestionCandidates(payload?.questions || payload?.data || payload);
            return questions.map(question => ({ ...question, __inheritedTopic: questionTopicLabel(question) || topic.topic_name }));
        } catch (error) {
            console.warn(`Custom test source failed for topic ${topicId}:`, error.message);
            return [];
        }
    }));
    res.json({ success: true, data: { questions: sampleQuestions(questionSets.flat()), topic_ids: topicIds, difficulty } });
}));

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
// 404 + ERROR HANDLERS
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
