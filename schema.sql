CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, phone TEXT UNIQUE,
 password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('patient','doctor','superadmin')),
 preferred_language TEXT NOT NULL DEFAULT 'bn', active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS schedules (
 id TEXT PRIMARY KEY, day_of_week INTEGER NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
 slot_minutes INTEGER NOT NULL DEFAULT 20, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS appointments (
 id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES users(id), visit_type TEXT NOT NULL CHECK(visit_type IN ('first','followup')),
 fee INTEGER NOT NULL, appointment_date TEXT NOT NULL, start_time TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','in_consultation','completed','cancelled','no_show')),
 reason TEXT, patient_full_name TEXT, patient_mobile TEXT, patient_email TEXT, patient_age INTEGER,
 video_room TEXT, payment_status TEXT NOT NULL DEFAULT 'unpaid', payment_method TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_slot ON appointments(appointment_date,start_time) WHERE status IN ('pending','confirmed','in_consultation');
CREATE TABLE IF NOT EXISTS prescriptions (
 id TEXT PRIMARY KEY, appointment_id TEXT NOT NULL UNIQUE REFERENCES appointments(id), doctor_id TEXT NOT NULL REFERENCES users(id),
 diagnosis TEXT, medicines_json TEXT NOT NULL DEFAULT '[]', advice TEXT, followup_date TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS medical_files (
 id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES users(id), appointment_id TEXT REFERENCES appointments(id),
 original_name TEXT NOT NULL, storage_key TEXT NOT NULL, mime_type TEXT NOT NULL, uploaded_by TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS payments (
 id TEXT PRIMARY KEY, appointment_id TEXT NOT NULL REFERENCES appointments(id), amount INTEGER NOT NULL,
 method TEXT NOT NULL, provider_reference TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_logs (
 id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, target_type TEXT, target_id TEXT, details_json TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
