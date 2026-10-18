# DoctorCare — Single Doctor Appointment & Telemedicine Starter

এটি Node.js + Express + Turso/libSQL ভিত্তিক bilingual (Bangla/English) starter app। এতে patient registration/login, Patient Information Form (Patient Full Name, Mobile Number, Age, Reason for Visit), appointment request, ৳500 first visit, ৳300 follow-up, cancellation, doctor/superadmin dashboard, status changes, prescription API এবং audit logging-এর ভিত্তি আছে। Patient information প্রতিটি appointment record-এ সংরক্ষিত হয়; Doctor Dashboard-এ নাম, মোবাইল, বয়স ও ভিজিটের কারণ দেখা যায়।

## চালানো
1. **Node.js 22 LTS (64-bit Windows)** ইনস্টল করুন। Node.js 26 ব্যবহার করবেন না—এই প্রজেক্টের local libSQL database native module ব্যবহার করে, যা আপনার Node.js 26.10.0-এ `ERR_DLOPEN_FAILED` দিচ্ছে।
2. এই ফোল্ডারে `.env.example` কপি করে `.env` বানান।
3. `JWT_SECRET`-এ দীর্ঘ random secret দিন এবং `ADMIN_EMAIL`, `ADMIN_PASSWORD` বদলান।
4. আগে পুরোনো dependency মুছে ফেলুন: PowerShell-এ `Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue`
5. `npm install`
6. `npm ls libsql @libsql/client` চালিয়ে dependency পরীক্ষা করুন।
7. `npm start`
6. `http://localhost:10000` খুলুন।

## Windows-এ `ERR_DLOPEN_FAILED` হলে
- Node.js 22 LTS x64 install করার পর সব পুরোনো PowerShell/terminal বন্ধ করে নতুন terminal খুলুন।
- `node -v` দিয়ে `v22.x.x` দেখাচ্ছে কি না নিশ্চিত করুন।
- প্রজেক্ট ফোল্ডারে `Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue` চালান।
- `npm install` তারপর `npm start` চালান।
- `npm ls libsql @libsql/client`-এ `libsql` dependency দেখালে সেটি `@libsql/client`-এর local SQLite adapter-এর অংশ হতে পারে; অন্ধভাবে `npm uninstall libsql` করে package tree ভাঙবেন না।

## Patient Information Form
- রোগী লগইন করে অ্যাপয়েন্টমেন্টের সময় পূর্ণ নাম, মোবাইল নম্বর, বয়স এবং ভিজিটের কারণ জমা দেবেন।
- Server-side validation: নাম 2–120 অক্ষর, মোবাইল 7–25 অনুমোদিত অক্ষর, বয়স 0–120 পূর্ণসংখ্যা, কারণ সর্বোচ্চ 1000 অক্ষর।
- তথ্য `appointments` টেবিলের `patient_full_name`, `patient_mobile`, `patient_age`, `reason` কলামে সেভ হয়।
- পুরোনো SQLite/Turso database হলে সার্ভার শুরুতে missing patient columns যোগ করার migration চালায়; বিদ্যমান appointment data মুছে ফেলে না।
- Doctor/Super Admin dashboard appointment list-এ এই তথ্য দেখা যায়। Patient নিজের appointment list-এও তা দেখতে পারবেন।

## Turso/Render
- Turso database তৈরি করে `TURSO_DATABASE_URL` ও `TURSO_AUTH_TOKEN` environment variables সেট করুন।
- Render-এ Node Web Service হিসেবে deploy করুন; Build command `npm install`, Start command `npm start`।
- `ADMIN_PASSWORD` ও `JWT_SECRET` secrets হিসেবে সেট করুন; source code-এ রাখবেন না।

## Demo সীমাবদ্ধতা — production-এর আগে কাজ বাকি
- `doctor@example.com` তৈরি হয় কিন্তু password ইচ্ছাকৃতভাবে random; doctor-এর জন্য secure invite/password-reset flow যোগ করতে হবে।
- UI-তে video call, real payment gateway, SMS/email, prescription editor/PDF এবং secure file-upload workflow এখনো সম্পূর্ণভাবে সংযুক্ত নয়। Database-এ prescription/file metadata schema রয়েছে।
- Schedule UI-র time list ডেমো; production-এ doctor schedule database থেকে তৈরি করতে হবে। Time-zone handling ও slot availability transaction test করতে হবে।
- Fee config UI-তে উদাহরণ; production-এ server-side settings table এবং superadmin-only update endpoint যোগ করতে হবে।
- Payment confirmation অবশ্যই verified gateway webhook থেকে আসবে; client থেকে payment paid করা যাবে না।
- Medical files private object storage-এ রাখতে হবে, short-lived signed URLs, MIME/size validation, malware scanning ও access audit সহ।
- Prescription PDF, video provider, notifications, rate limiting, backup/restore, account recovery, MFA, monitoring, consent, privacy policy এবং applicable Bangladesh/US healthcare/data laws review করতে হবে।
- Seed/demo account-কে production-এ ব্যবহার করবেন না। Test with synthetic data only.

## Main API
- `GET /api/health`, `GET /api/config`
- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/me`
- `GET/POST /api/appointments`
- `PATCH /api/appointments/:id/cancel`
- `PATCH /api/appointments/:id/status`
- `PUT /api/appointments/:id/prescription`
- `GET /api/admin/summary`, `GET /api/admin/patients`, `GET /api/admin/audit`

This is a development starter, not a production-ready medical system. Do not upload real patient information until security and compliance work is complete.
