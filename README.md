# Techfinder Accounting: ขึ้นเว็บพร้อมระบบ Login และฐานข้อมูล

แอปบัญชี (ลูกค้า, ใบเสนอราคา, ใบเสร็จ, รายรับ-รายจ่าย, ภาษี) ที่ TFD ใช้อยู่
พร้อมขึ้นใช้งานผ่านเว็บได้ทันที โดยมีระบบ Login และบันทึกลงฐานข้อมูล

```
ผู้ใช้ ──HTTPS──▶ Cloudflare Access (Login: OTP ทางอีเมล / Google / Microsoft)
                     │  ผ่านเฉพาะอีเมลที่อนุญาต
                     ▼
              Cloudflare Pages ── public/index.html (ตัวแอป)
                     │
                     ▼
              Pages Functions  /api/data  (ตรวจ JWT ของ Access ซ้ำอีกชั้น)
                     │
                     ▼
              Cloudflare D1 (ฐานข้อมูล SQLite) เก็บทุกเวอร์ชันที่บันทึก + ใครบันทึก
```

## ทำไมเลือกแบบนี้

| ตัวเลือก | Login | ฐานข้อมูล | ค่าใช้จ่าย (ทีมเล็ก) | ต้องแก้แอป |
|---|---|---|---|---|
| **Cloudflare Pages + Access + D1 (แนะนำ)** | Cloudflare Access (Zero Trust) รองรับ OTP / Google / Microsoft / 2FA | D1 (SQLite) ย้อนเวลากู้ข้อมูลได้ 30 วัน | **ฟรี** (Access ฟรีสูงสุด 50 คน) | แทบไม่ต้องแก้ เพราะแอปเรียก `/api/data` อยู่แล้ว |
| Supabase + Vercel/Netlify | Supabase Auth | PostgreSQL + Row Level Security | ฟรี (โปรเจกต์ฟรีจะหยุดเมื่อไม่ได้ใช้ 7 วัน), Pro ราว $25/เดือน | ต้องเขียน login และส่วนเรียก DB ใหม่ |
| Firebase Hosting + Auth + Firestore | Firebase Auth | Firestore (NoSQL) | ฟรีถึงระดับหนึ่ง | ต้องเขียนใหม่ด้วย Firebase SDK |
| Render / Railway (Node.js + PostgreSQL) | เขียนเอง (เสี่ยงกว่า) | PostgreSQL | ราว $7–20/เดือน | ต้องเขียน backend และระบบ login เอง |

เหตุผลที่แนะนำ Cloudflare:
- **ไม่ต้องเก็บรหัสผ่านเอง**: Login ทำโดย Cloudflare Access จึงไม่มีรหัสผ่านให้รั่วจากระบบเรา
  และเปิด 2FA ได้ด้วยการใช้ Google/Microsoft Workspace
- **คนที่ไม่ได้รับอนุญาตเข้าไม่ถึงเลย** แม้แต่หน้าเว็บ (ข้อมูลบัญชีธนาคารและเลขผู้เสียภาษีที่อยู่ในแอปจึงไม่หลุด)
- มีเซิร์ฟเวอร์ในกรุงเทพฯ จึงเร็ว, มี HTTPS อัตโนมัติ และฟรีสำหรับทีมเล็ก

## ความปลอดภัยที่ใส่ไว้แล้ว

1. **Login 2 ชั้น**: Cloudflare Access กั้นหน้าเว็บ และ `functions/api/_middleware.js`
   ตรวจลายเซ็น JWT ของ Access ซ้ำทุก request (ทั้ง audience, issuer และวันหมดอายุ)
   เผื่อ Access ตั้งค่าผิดหรือมีคนเข้า URL `*.pages.dev` ตรง ๆ
2. **รายชื่ออีเมลที่อนุญาต** (`ALLOWED_EMAILS`) เป็นชั้นเสริมบนนโยบายของ Access
3. **บันทึกทุกเวอร์ชัน**: ทุกครั้งที่กดบันทึกจะเก็บเป็นแถวใหม่ พร้อมอีเมลคนบันทึกและเวลา (เก็บ 1,000 เวอร์ชันล่าสุด)
   ลบหรือเขียนทับผิดก็ย้อนกลับได้
4. **กันข้อมูลหาย**: ถ้าโหลดข้อมูลไม่สำเร็จ (เน็ตหลุด หรือ Login หมดอายุ) แอปจะไม่เปิดด้วยข้อมูลว่าง
   (เวอร์ชันเดิมจะเปิดด้วยข้อมูลว่าง แล้วการบันทึกครั้งถัดไปจะเขียนทับข้อมูลจริง)
5. **กัน CSRF**: API รับเฉพาะ `application/json`
6. **Security headers** (`public/_headers`): CSP, HSTS, ห้ามฝังหน้าใน iframe, nosniff
7. ปุ่ม **ออกจากระบบ** และอีเมลผู้ใช้ที่ด้านล่างแถบเมนู

## วิธีขึ้นระบบ (ครั้งแรก ประมาณ 20 นาที)

ต้องมี: บัญชี Cloudflare (ฟรี) และ Node.js 20 ขึ้นไป

```bash
npm install
npx wrangler login

# 1) สร้างฐานข้อมูล แล้วนำ database_id ที่ได้ไปใส่ใน wrangler.toml
npx wrangler d1 create techfinder-db
npm run db:init:remote

# 2) Deploy (ครั้งแรกจะถามชื่อโปรเจกต์ ให้ใช้ techfinder-accounting)
npm run deploy
```

หรือจะเชื่อม GitHub repo นี้กับ Cloudflare Pages ก็ได้
(Workers & Pages > Create > Pages > Connect to Git, build output = `public`)
แล้วทุกครั้งที่ push จะ deploy ให้อัตโนมัติ (ยังต้องผูก D1 ในขั้นตอนที่ 3)

**3) ผูกฐานข้อมูล** (ถ้า deploy ผ่าน GitHub):
Pages project > Settings > Bindings > Add > D1 database: ตั้งชื่อตัวแปร `DB` แล้วเลือก `techfinder-db`

**4) ตั้งค่า Login ด้วย Cloudflare Access**
1. เข้า Cloudflare dashboard > **Zero Trust** (เลือกแพลน Free และตั้งชื่อทีม เช่น `tfd`)
2. Access > Applications > **Add an application** > Self-hosted
   - Domain: `techfinder-accounting.pages.dev` และเพิ่มอีกรายการเป็น `*.techfinder-accounting.pages.dev`
     (เพื่อกั้น preview URL ด้วย) และโดเมนของบริษัท ถ้ามี
   - Session duration: แนะนำ 8–24 ชั่วโมง
3. Policy: Action = **Allow**, Include = **Emails** แล้วใส่อีเมลของคนที่ใช้งาน
   (หรือ "Emails ending in" `@techfinder.one`)
4. Login methods: เปิด **One-time PIN** (ส่งรหัสทางอีเมล) หรือเชื่อม Google / Microsoft เพื่อใช้ 2FA ของบัญชีนั้น
5. ในหน้าของ application ให้คัดลอก **Application Audience (AUD) Tag**

**5) ตั้งค่าตัวแปร** ที่ Pages project > Settings > Variables and Secrets (Production):

| ชื่อ | ค่า |
|---|---|
| `ACCESS_TEAM_DOMAIN` | `https://<ชื่อทีม>.cloudflareaccess.com` |
| `ACCESS_AUD` | AUD Tag จากขั้นตอนที่ 4 |
| `ALLOWED_EMAILS` | (ไม่บังคับ) เช่น `a@techfinder.one,b@techfinder.one` |

แล้ว deploy ใหม่อีกครั้ง (`npm run deploy` หรือกด Retry deployment)

> ห้ามตั้ง `DEV_BYPASS_AUTH` บน production ค่านี้ใช้เฉพาะตอนทดสอบบนเครื่องตัวเอง
> (และโค้ดยอมให้ข้ามการตรวจเฉพาะเมื่อเปิดจาก localhost เท่านั้น)

## เพิ่มผู้ใช้และกำหนดสิทธิ์

ผู้ดูแลระบบเพิ่มหรือลบผู้ใช้ได้เองในแอป ที่เมนู **ผู้ใช้งาน** (เห็นเฉพาะผู้ดูแลระบบ) แล้วส่งลิงก์แอปให้ผู้ใช้
ผู้ใช้จะได้รับรหัส OTP ทางอีเมลตอนเข้าสู่ระบบ

| สิทธิ์ | ทำอะไรได้ |
|---|---|
| ผู้ดูแลระบบ (admin) | ทุกอย่าง รวมถึงเพิ่ม/ลบผู้ใช้และเปลี่ยนสิทธิ์ |
| ผู้แก้ไข (editor) | สร้าง แก้ไข และลบเอกสาร |
| ดูอย่างเดียว (viewer) | ดูและพิมพ์เอกสาร แก้ไขไม่ได้ |

ระบบมี 2 ชั้น: Cloudflare Access ยืนยันว่าผู้ใช้เป็นเจ้าของอีเมลจริง (OTP) แล้ว `functions/_middleware.js`
ตรวจว่าอีเมลนั้นอยู่ในตาราง `users` ทุก request (รวมถึงตัวหน้าเว็บ) ถ้าไม่อยู่ จะเห็นหน้า "ยังไม่ได้รับสิทธิ์"
ผู้ดูแลลดสิทธิ์หรือลบตัวเองไม่ได้ และต้องมีผู้ดูแลอย่างน้อย 1 คนเสมอ

ผู้ดูแลคนแรกต้องเพิ่มผ่าน SQL ครั้งเดียว:
```bash
npx wrangler d1 execute techfinder-db --remote --command \
  "INSERT INTO users (email, name, role, added_by, added_at) VALUES ('you@company.com', 'Owner', 'admin', 'setup', datetime('now'))"
```

## ทดสอบบนเครื่องตัวเอง

```bash
cp .dev.vars.example .dev.vars
npm run db:init:local
npm run dev        # เปิด http://localhost:8788
```
ตอนทดสอบจะเป็นผู้ดูแลระบบอัตโนมัติ ถ้าจะลองสิทธิ์อื่น ให้ใส่ `DEV_USER=อีเมล` ใน `.dev.vars` (อีเมลนั้นต้องอยู่ในตาราง `users` ของฐานข้อมูลบนเครื่อง)

## สำรองและกู้ข้อมูล

```bash
# ดูประวัติการบันทึก
npx wrangler d1 execute techfinder-db --remote \
  --command "SELECT id, saved_by, saved_at, length(value) FROM state_versions ORDER BY id DESC LIMIT 20"

# ย้อนกลับไปเวอร์ชัน id = 123 (คัดลอกเวอร์ชันนั้นมาเป็นเวอร์ชันล่าสุด)
npx wrangler d1 execute techfinder-db --remote \
  --command "INSERT INTO state_versions (value, saved_by, saved_at) SELECT value, 'restore-from-123', datetime('now') FROM state_versions WHERE id = 123"

# Export ทั้งฐานข้อมูลเก็บไว้ (แนะนำให้ทำทุกเดือน)
npx wrangler d1 export techfinder-db --remote --output=backup.sql

# กู้ทั้งฐานข้อมูลกลับไปยังจุดเวลาใดก็ได้ในช่วง 30 วัน (D1 Time Travel)
npx wrangler d1 time-travel restore techfinder-db --timestamp=2026-10-01T09:00:00+07:00
```

## ข้อจำกัดที่ควรรู้ และแผนต่อไป

- แอปบันทึกข้อมูลทั้งหมดเป็นก้อนเดียว ถ้า **2 คนแก้พร้อมกัน คนที่บันทึกทีหลังจะทับของอีกคน**
  (ยังกู้คืนได้จากประวัติเวอร์ชัน) ถ้าจะใช้หลายคนพร้อมกันเป็นประจำ ขั้นต่อไปควรแยกตาราง
  `clients`, `quotations`, `receipts`, `transactions` ใน D1 และให้ API บันทึกทีละรายการ
- ข้อมูลทั้งหมดต้องไม่เกินประมาณ 1.9 MB (ข้อความล้วนรองรับเอกสารได้หลายพันใบ)
- ข้อมูลลูกค้าเป็นข้อมูลส่วนบุคคลตาม PDPA ควรให้สิทธิ์เฉพาะคนที่จำเป็น และ export สำรองไว้เป็นระยะ

## โครงสร้างไฟล์

```
public/index.html            ตัวแอป (เพิ่ม: กันข้อมูลหายตอนโหลดไม่สำเร็จ, ปุ่มออกจากระบบ)
public/_headers              security headers
functions/api/_middleware.js ตรวจ Login (JWT ของ Cloudflare Access)
functions/api/data.js        GET/POST /api/data อ่าน/บันทึกลง D1
schema.sql                   ตารางฐานข้อมูล
wrangler.toml                ค่าตั้งของ Cloudflare
```
