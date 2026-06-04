require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const midtransClient = require('midtrans-client');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Penyimpanan Metadata & Gambar di luar workspace (untuk mencegah Live Server reload otomatis)
const fs = require('fs');
const path = require('path');

// Menggunakan folder /tmp jika di Vercel, atau folder lokal jika di komputer sendiri
const isVercel = process.env.VERCEL;
const uploadDir = isVercel 
  ? path.join('/tmp', 'uploads') 
  : path.join(__dirname, 'uploads'); 

if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Sajikan folder uploads secara statis untuk gambar cover event
app.use('/uploads', express.static(UPLOADS_DIR));

// Hubungkan ke Supabase & Midtrans
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function readMetadata() {
    try {
        if (fs.existsSync(METADATA_FILE)) {
            return JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
        }
    } catch (err) {
        console.error("Gagal membaca file metadata lokal:", err);
    }
    return {};
}

function writeMetadata(data) {
    try {
        fs.writeFileSync(METADATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error("Gagal menulis file metadata lokal:", err);
    }
}


// Inisialisasi Midtrans Snap SDK menggunakan env SECRET
let snap = new midtransClient.Snap({
    isProduction: false,
    serverKey: process.env.SECRET
});

// 1. API: Mengambil semua daftar event untuk Halaman Utama (Hanya event mendatang)
app.get('/api/events', async (req, res) => {
    try {
        const currentDate = new Date().toISOString();
        const { data, error } = await supabase
            .from('events')
            .select('*')
            .gte('event_date', currentDate)
            .order('event_date', { ascending: true });

        console.log("=== LAPORAN API EVENTS ===");
        console.log("Data dari Supabase:", data);
        if (error) console.log("Error dari Supabase:", error);

        const metadata = readMetadata();
        const mergedData = (data || []).map(event => {
            const meta = metadata[event.id] || {};
            return {
                ...event,
                description: event.description || meta.description || '',
                image_url: event.image_url || meta.image_url || `https://picsum.photos/id/${event.id * 100}/500/300`
            };
        });

        res.json(mergedData);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. API: Mengambil detail satu event beserta variasi kelas tiketnya
app.get('/api/event-details/:id', async (req, res) => {
    try {
        const eventId = req.params.id;
        const { data: event, error: err1 } = await supabase.from('events').select('*').eq('id', eventId).single();
        const { data: categories, error: err2 } = await supabase.from('ticket_categories').select('*').eq('event_id', eventId);
        
        if (err1 || err2) return res.status(500).json({ error: "Gagal memuat detail tiket event" });

        const metadata = readMetadata();
        const meta = metadata[eventId] || {};
        const mergedEvent = {
            ...event,
            description: event.description || meta.description || '',
            image_url: event.image_url || meta.image_url || `https://picsum.photos/id/${eventId * 100}/800/400`
        };

        const catMeta = meta.categories || {};
        const mergedCategories = (categories || []).map(cat => {
            const extra = catMeta[cat.id] || {};
            return {
                ...cat,
                original_price: extra.original_price || null,
                description: extra.description || ''
            };
        });

        res.json({ event: mergedEvent, categories: mergedCategories });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// 2b. API: Mendaftarkan Event Baru beserta Kategori-kategori Tiket (Memerlukan Login)
app.post('/api/events', async (req, res) => {
    try {
        // Verifikasi autentikasi user
        const user = await getUserIdFromToken(req);
        if (!user) {
            return res.status(401).json({ message: "Anda harus login terlebih dahulu untuk mendaftarkan event!" });
        }

        const { title, location, eventDate, categories, description, imageUrl } = req.body;

        if (!title || !location || !eventDate || !categories || !Array.isArray(categories) || categories.length === 0) {
            return res.status(400).json({ message: "Semua field event dan kategori tiket wajib diisi!" });
        }

        // Validasi isi kategori tiket
        for (const cat of categories) {
            if (!cat.categoryName || cat.price === undefined || !cat.quota) {
                return res.status(400).json({ message: "Semua kategori tiket wajib diisi dengan lengkap!" });
            }
        }

        // 1. Insert Event baru ke database Supabase
        let eventData, eventError;
        try {
            const resSupabase = await supabase
                .from('events')
                .insert([{
                    title: title,
                    location: location,
                    event_date: eventDate,
                    description: description,
                    image_url: imageUrl
                }])
                .select()
                .single();
            eventData = resSupabase.data;
            eventError = resSupabase.error;
        } catch (err) {
            eventError = err;
        }

        // Jika terdapat error karena kolom database tidak ditemukan (Error 42703 atau mengandung kata 'column')
        if (eventError && (eventError.code === '42703' || String(eventError.message).includes('column'))) {
            console.log("Supabase belum memiliki kolom description/image_url. Melakukan fallback insert dasar...");
            const resSupabaseBasic = await supabase
                .from('events')
                .insert([{
                    title: title,
                    location: location,
                    event_date: eventDate
                }])
                .select()
                .single();
            eventData = resSupabaseBasic.data;
            eventError = resSupabaseBasic.error;

            if (!eventError && eventData) {
                // Simpan metadata dan info kepemilikan secara lokal
                const metadata = readMetadata();
                metadata[eventData.id] = {
                    description: description || '',
                    image_url: imageUrl || '',
                    owner_id: user.id,
                    owner_email: user.email
                };
                writeMetadata(metadata);
            }
        } else if (!eventError && eventData) {
            // Jika berhasil masuk kolom native, tetap simpan info owner secara lokal untuk kontrol autentikasi
            const metadata = readMetadata();
            metadata[eventData.id] = {
                owner_id: user.id,
                owner_email: user.email
            };
            writeMetadata(metadata);
        }

        if (eventError || !eventData) {
            console.error("Gagal menambahkan event ke Supabase:", eventError);
            return res.status(500).json({ message: "Gagal mendaftarkan event baru." });
        }

        // 2. Insert seluruh Kategori Tiket untuk event tersebut (Bulk Insert)
        const categoriesToInsert = categories.map(cat => ({
            event_id: eventData.id,
            category_name: cat.categoryName,
            price: Number(cat.price),
            quota: Number(cat.quota),
            booked: 0,
            is_resell: false
        }));

        const { data: insertedCats, error: categoryError } = await supabase
            .from('ticket_categories')
            .insert(categoriesToInsert)
            .select();

        if (categoryError) {
            console.error("Gagal menambahkan kategori-kategori tiket:", categoryError);
            // Cleanup event jika gagal membuat kategori
            await supabase.from('events').delete().eq('id', eventData.id);
            return res.status(500).json({ message: "Gagal membuat kategori tiket untuk event ini." });
        }

        // Simpan metadata ekstra kategori tiket secara lokal
        if (insertedCats && Array.isArray(insertedCats)) {
            const metadata = readMetadata();
            if (!metadata[eventData.id]) {
                metadata[eventData.id] = {};
            }
            if (!metadata[eventData.id].categories) {
                metadata[eventData.id].categories = {};
            }
            insertedCats.forEach(insertedCat => {
                const originalCatPayload = categories.find(c => c.categoryName === insertedCat.category_name);
                if (originalCatPayload) {
                    metadata[eventData.id].categories[insertedCat.id] = {
                        original_price: originalCatPayload.originalPrice ? Number(originalCatPayload.originalPrice) : null,
                        description: originalCatPayload.description || ''
                    };
                }
            });
            writeMetadata(metadata);
        }

        res.status(201).json({ message: "Event berhasil didaftarkan dengan kategori tiket aktif!", event: eventData });

    } catch (err) {
        console.error("Error pada pendaftaran event:", err);
        res.status(500).json({ message: "Terjadi kesalahan pada sistem." });
    }
});

// 2c. API: Memperbarui Foto & Deskripsi Event (Hanya pemilik event)
app.put('/api/events/:id', async (req, res) => {
    try {
        const user = await getUserIdFromToken(req);
        if (!user) {
            return res.status(401).json({ message: "Anda harus login terlebih dahulu untuk mengedit event!" });
        }

        const eventId = req.params.id;
        const { description, imageUrl } = req.body;

        const metadata = readMetadata();
        const eventMeta = metadata[eventId] || {};

        // Verifikasi kepemilikan: Jika sudah ada owner, pastikan datanya cocok
        if (eventMeta.owner_id && eventMeta.owner_id !== user.id) {
            return res.status(403).json({ message: "Anda tidak berhak mengedit event ini!" });
        }

        // Coba perbarui di database Supabase (jika kolom exists)
        let dbSuccess = false;
        try {
            const { error } = await supabase
                .from('events')
                .update({
                    description: description,
                    image_url: imageUrl
                })
                .eq('id', eventId);
            
            if (!error) {
                dbSuccess = true;
            }
        } catch (dbErr) {
            // Abaikan error jika kolom tidak didukung
        }

        // Selalu perbarui metadata lokal sebagai fallback utama
        metadata[eventId] = {
            ...eventMeta,
            description: description !== undefined ? description : eventMeta.description,
            image_url: imageUrl !== undefined ? imageUrl : eventMeta.image_url,
            owner_id: eventMeta.owner_id || user.id,
            owner_email: eventMeta.owner_email || user.email
        };
        writeMetadata(metadata);

        res.json({ message: "Event berhasil diperbarui!", dbSuccess });
    } catch (err) {
        console.error("Error memperbarui event:", err);
        res.status(500).json({ message: "Terjadi kesalahan pada sistem saat memperbarui event." });
    }
});

// 2d. API: Mengambil daftar event yang dibuat oleh user untuk dikelola
app.get('/api/my-events', async (req, res) => {
    try {
        const user = await getUserIdFromToken(req);
        if (!user) {
            return res.status(401).json({ message: "Anda harus login terlebih dahulu!" });
        }

        // Ambil semua daftar event
        const { data, error } = await supabase
            .from('events')
            .select('*')
            .order('event_date', { ascending: true });

        if (error) {
            console.error("Gagal mengambil data event Supabase:", error);
            return res.status(500).json({ error: "Gagal mengambil daftar event." });
        }

        const metadata = readMetadata();

        // Saring event yang dimiliki oleh user aktif
        // Untuk mempermudah pengujian: jika data event belum diatur owner lokalnya, izinkan user mengeditnya
        const myEvents = (data || []).filter(event => {
            const meta = metadata[event.id] || {};
            return !meta.owner_id || meta.owner_id === user.id;
        }).map(event => {
            const meta = metadata[event.id] || {};
            return {
                ...event,
                description: event.description || meta.description || '',
                image_url: event.image_url || meta.image_url || `https://picsum.photos/id/${event.id * 100}/500/300`
            };
        });

        res.json(myEvents);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2e. API: Mengunggah gambar/foto cover event secara lokal (Simpan di /uploads)
app.post('/api/upload-image', async (req, res) => {
    try {
        const { imageBase64, fileName } = req.body;
        if (!imageBase64) {
            return res.status(400).json({ error: "Data gambar tidak ditemukan." });
        }

        // Hapus header skema base64 data jika ada (misal: data:image/png;base64,)
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');

        const fileExt = fileName ? path.extname(fileName) : '.png';
        const uniqueFileName = `event-${Date.now()}${fileExt}`;
        const filePath = path.join(UPLOADS_DIR, uniqueFileName);

        fs.writeFileSync(filePath, buffer);

        // Berikan URL akses static
        const imageUrl = `http://localhost:3000/uploads/${uniqueFileName}`;
        res.json({ imageUrl });
    } catch (err) {
        console.error("Error mengunggah gambar:", err);
        res.status(500).json({ error: "Gagal memproses unggahan file gambar." });
    }
});

// Helper: Verifikasi Token JWT Supabase dari Header Authorization
async function getUserIdFromToken(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null;
    }
    const token = authHeader.split(' ')[1];
    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) {
            console.error("Gagal memverifikasi token Supabase:", error);
            return null;
        }
        return user;
    } catch (err) {
        console.error("Error pada verifikasi token:", err);
        return null;
    }
}

// 3. API: Checkout & Integrasi Midtrans (Sudah Diperbaiki)
app.post('/api/checkout', async (req, res) => {
    try {
        const { categoryId, name, email, eventId } = req.body;

        // WAJIB LOGIN: Verifikasi autentikasi user
        const user = await getUserIdFromToken(req);
        if (!user) {
            return res.status(401).json({ message: "Anda harus login terlebih dahulu untuk membeli tiket!" });
        }



        if (!categoryId) {
            return res.status(400).json({ message: "Kategori tiket wajib dipilih!" });
        }

        // Ambil data kategori dari DB Supabase
        const { data: categoryData, error: dbError } = await supabase
            .from('ticket_categories')
            .select('price, category_name, quota, booked')
            .eq('id', categoryId)
            .single();

        if (dbError || !categoryData) {
            console.error("Gagal mengambil data kategori:", dbError);
            return res.status(404).json({ message: "Kategori tiket tidak ditemukan di database." });
        }

        // Validasi jika tiket sudah habis
        if (categoryData.booked >= categoryData.quota) {
            return res.status(400).json({ message: `Tiket untuk kategori "${categoryData.category_name}" sudah habis terjual!` });
        }

        const exactPrice = Number(categoryData.price) + 3000;
        const orderId = "YOTIKET-" + Date.now();

        // [PERBAIKAN] Langkah Wajib: Simpan data awal dengan status PENDING ke Supabase 
        // supaya API status dan callback tidak menghasilkan error "data tidak ditemukan"
        const { error: insertError } = await supabase
            .from('transactions')
            .insert([{
                order_id: orderId,
                category_id: categoryId,
                customer_name: name,
                customer_email: email,
                status: 'PENDING',
                amount: Number(exactPrice)
            }]);

        if (insertError) {
            console.error("Gagal mencatat transaksi awal ke Supabase:", insertError);
            return res.status(500).json({ message: "Gagal membuat invoice sistem." });
        }

        // Buat parameter untuk Midtrans Snap
        let parameter = {
            "transaction_details": {
                "order_id": orderId,
                "gross_amount": Number(exactPrice)
            },
            "customer_details": {
                "first_name": name,
                "email": email
            },
            "credit_card": {
                "secure": true
            },
            "callback": {
        "finish": "http://localhost:3000", // Setelah sukses, kembali ke web Anda (bukan example.com)
        "error": "http://localhost:3000",
        "pending": "http://localhost:3000"
            }
        };

        // Minta token transaksi ke Midtrans Snap
        const transaction = await snap.createTransaction(parameter);
        
        // Kirim response balik ke Frontend
        res.json({ 
            redirect_url: transaction.redirect_url, 
            token: transaction.token,
            orderId: orderId 
        });

    } catch (err) {
        console.error("=== ERROR MIDTRANS ASLI ===");
        console.error(err);
        res.status(500).json({ message: "Gagal memproses link pembayaran Midtrans." });
    }
});

// 4. API: Webhook Midtrans (Notifikasi Pembayaran Otomatis)
const nodemailer = require('nodemailer');

// Konfigurasi Pengirim Email menggunakan data dari .env
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Helper: Memproses finalisasi transaksi menjadi sukses (PAID) dan kirim tiket ke email
async function finalizePayment(order_id) {
    try {
        // Cek status transaksi saat ini di database
        const { data: existingTrx, error: fetchErr } = await supabase
            .from('transactions')
            .select('status')
            .eq('order_id', order_id)
            .single();

        if (fetchErr || !existingTrx) {
            console.error(`Transaksi ${order_id} tidak ditemukan untuk finalisasi.`);
            return null;
        }

        // Jika sudah PAID atau USED, tidak perlu diproses ulang
        if (existingTrx.status === 'PAID' || existingTrx.status === 'USED') {
            console.log(`Transaksi ${order_id} sudah bernilai status ${existingTrx.status}.`);
            const { data: fullTrx } = await supabase
                .from('transactions')
                .select('*')
                .eq('order_id', order_id)
                .single();
            return fullTrx;
        }

        const ticketCode = `TIX-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
        const qrCodeBase64 = await QRCode.toDataURL(ticketCode);

        // Update status transaksi pembeli baru menjadi PAID di database
        const { data: trx, error: trxError } = await supabase
            .from('transactions')
            .update({ status: 'PAID', ticket_code: ticketCode, qr_code_url: qrCodeBase64 })
            .eq('order_id', order_id)
            .select()
            .single();

        if (trxError) {
            console.error("Error update transaksi PAID:", trxError);
            return null;
        }

        if (trx) {
            // --- PROSES KIRIM EMAIL OTOMATIS DIMULAI DI SINI ---
            const mailOptions = {
                from: `"YoTiket Official" <${process.env.EMAIL_USER}>`,
                to: trx.customer_email, // Email pembeli yang diambil dari database
                subject: `E-Ticket Lunas - ${trx.order_id}`,
                html: `
                    <div style="font-family: 'Plus Jakarta Sans', sans-serif; background-color: #f8fafc; padding: 40px 20px; color: #334155;">
                        <div style="max-w: 600px; margin: 0 auto; background: #ffffff; border-radius: 24px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
                            
                            <!-- Header / Navbar ala Yesplis -->
                            <div style="background-color: #ffffff; padding: 25px; border-bottom: 1px solid #f1f5f9; text-align: center;">
                                <img src="cid:logo_yotiket" alt="YoTiket Logo" style="height: 50px; width: auto; display: block; margin: 0 auto;"/>
                            </div>
                            
                            <!-- Content Body -->
                            <div style="padding: 40px 30px;">
                                <h2 style="font-size: 22px; font-weight: 800; color: #0f172a; margin-top: 0; margin-bottom: 10px; text-align: center;">Halo ${trx.customer_name}, Pembayaran Sukses!</h2>
                                <p style="font-size: 15px; line-height: 1.6; color: #475569; text-align: center; margin-bottom: 30px;">Terima kasih telah melakukan pembelian tiket di YoTiket. E-ticket resmi Anda telah sukses diterbitkan.</p>
                                
                                <!-- Detail Card Box -->
                                <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 16px; padding: 20px 25px; margin-bottom: 30px;">
                                    <h4 style="font-size: 12px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 0; margin-bottom: 15px;">Rincian Transaksi E-Ticket</h4>
                                    <table style="width: 100%; font-size: 14px; color: #334155; line-height: 1.8;">
                                        <tr>
                                            <td style="width: 35%; color: #64748b; font-weight: 500; padding: 4px 0;">Order ID</td>
                                            <td style="font-weight: 700; color: #0f172a; padding: 4px 0;">: ${trx.order_id}</td>
                                        </tr>
                                        <tr>
                                            <td style="color: #64748b; font-weight: 500; padding: 4px 0;">Kode Akses Tiket</td>
                                            <td style="font-family: monospace; font-size: 16px; color: #4f46e5; font-weight: 800; padding: 4px 0;">: ${ticketCode}</td>
                                        </tr>
                                    </table>
                                </div>
                                
                                <p style="font-size: 14px; line-height: 1.5; color: #475569; font-weight: 600; text-align: center; margin-bottom: 20px;">Silakan tunjukkan QR Code resmi ini ke gerbang masuk lokasi acara untuk dipindai:</p>
                                
                                <!-- QR Code Box -->
                                <div style="background-color: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 20px; padding: 25px; text-align: center; width: 220px; margin: 0 auto 30px;">
                                    <img src="cid:qrcode_ticket" alt="QR Code Tiket" style="width: 200px; height: 200px; display: block; border-radius: 12px; margin: 0 auto;"/>
                                </div>
                                
                                <p style="font-size: 12px; line-height: 1.5; color: #94a3b8; text-align: center; margin-top: 20px; border-top: 1px solid #f1f5f9; padding-top: 20px;">Ini adalah email transaksi otomatis resmi dari YoTiket. Mohon tidak membalas email ini.</p>
                            </div>
                        </div>
                    </div>
                `,
                attachments: [
                    {
                        filename: 'logo.png',
                        path: 'C:\\Users\\Jeparastore\\Documents\\percobaan\\frontend\\logo.png',
                        cid: 'logo_yotiket'
                    },
                    {
                        filename: 'qrcode.png',
                        path: qrCodeBase64, // Mengubah Base64 QR Code menjadi file lampiran gambar di dalam email
                        cid: 'qrcode_ticket' 
                    }
                ]
            };

            // Jalankan perintah kirim email
            transporter.sendMail(mailOptions, (mailErr, info) => {
                if (mailErr) {
                    console.error("Gagal mengirimkan email e-ticket:", mailErr);
                } else {
                    console.log("E-ticket berhasil dikirim ke email: " + trx.customer_email);
                }
            });
            // --- PROSES KIRIM EMAIL SELESAI ---

            // Logika tambahan untuk fitur resell/kuota (tetap seperti kode Anda sebelumnya)
            const { data: cat } = await supabase.from('ticket_categories').select('*').eq('id', trx.category_id).single();
            if (cat && cat.is_resell) {
                await supabase.from('transactions').update({ status: 'CANCELLED_BY_RESELL', is_for_resell: false }).eq('order_id', cat.original_transaction_id);
                await supabase.from('ticket_categories').delete().eq('id', cat.id);
            } else if (cat) {
                await supabase.from('ticket_categories').update({ booked: cat.booked + 1 }).eq('id', trx.category_id);
            }
        }

        return trx;
    } catch (err) {
        console.error("Gagal memfinalisasi transaksi:", err);
        return null;
    }
}

// 4. API: Webhook Midtrans (Notifikasi Pembayaran Otomatis + KIRIM EMAIL)
app.post('/api/payment-callback', async (req, res) => {
    try {
        const { order_id, transaction_status } = req.body;

        if (transaction_status === 'settlement' || transaction_status === 'capture') {
            await finalizePayment(order_id);
        } else if (transaction_status === 'expire' || transaction_status === 'cancel') {
            await supabase.from('transactions').update({ status: 'EXPIRED' }).eq('order_id', order_id);
        }
        res.sendStatus(200);
    } catch (error) {
        console.error("Error pada callback webhook:", error);
        res.status(500).send(error.message);
    }
});

// 5. API: Mengajukan Tiket untuk Dijual Kembali (Resell Resmi)
app.post('/api/resell-ticket', async (req, res) => {
    try {
        const { ticketCode, email } = req.body;

        const { data: ticket, error } = await supabase.from('transactions')
            .select('*, ticket_categories(*)')
            .eq('ticket_code', ticketCode).eq('customer_email', email).eq('status', 'PAID').single();

        if (error || !ticket) {
            return res.status(404).json({ message: "Validasi Gagal! Tiket tidak ditemukan atau sudah hangus/terpakai." });
        }
        if (ticket.is_for_resell) {
            return res.status(400).json({ message: "Tiket ini sudah dipajang di bursa resell." });
        }

        // Tandai tiket terkunci untuk resell
        await supabase.from('transactions').update({ is_for_resell: true }).eq('ticket_code', ticketCode);

        // Buat slot kategori tiket resell baru agar bisa dibeli orang lain
        await supabase.from('ticket_categories').insert([{
            event_id: ticket.ticket_categories.event_id,
            category_name: `[RESELL] ${ticket.ticket_categories.category_name}`,
            price: ticket.ticket_categories.price, 
            quota: 1, 
            booked: 0, 
            is_resell: true, 
            original_transaction_id: ticket.order_id
        }]);

        res.json({ message: "Sukses! Tiket Anda sekarang terpasang di bursa YoTiket Resell." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. API: Cek status pembayaran berkala oleh halaman frontend
app.get('/api/status/:orderId', async (req, res) => {
    try {
        const orderId = req.params.orderId;
        // 1. Dapatkan data transaksi di DB
        let { data: trx, error: dbError } = await supabase.from('transactions').select('*').eq('order_id', orderId).single();
        
        if (dbError || !trx) {
            return res.status(404).json({ error: "Transaksi tidak ditemukan" });
        }

        // 2. Jika statusnya masih PENDING di DB, cek langsung ke Midtrans!
        if (trx.status === 'PENDING') {
            try {
                const statusResponse = await snap.transaction.status(orderId);
                console.log(`Pengecekan status Midtrans untuk ${orderId}:`, statusResponse.transaction_status);
                
                if (statusResponse.transaction_status === 'settlement' || statusResponse.transaction_status === 'capture') {
                    // Update status dan kirim email!
                    const updatedTrx = await finalizePayment(orderId);
                    if (updatedTrx) {
                        trx = updatedTrx;
                    }
                } else if (statusResponse.transaction_status === 'expire' || statusResponse.transaction_status === 'cancel') {
                    const { data: expiredTrx } = await supabase.from('transactions').update({ status: 'EXPIRED' }).eq('order_id', orderId).select().single();
                    if (expiredTrx) {
                        trx = expiredTrx;
                    }
                }
            } catch (midtransErr) {
                // Abaikan error jika Midtrans belum memiliki record transaksi tersebut
                console.log("Pengecekan status ke Midtrans dilewati:", midtransErr.message);
            }
        }

        res.json(trx || {});
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6b. API: Mengambil riwayat transaksi user beserta relasi event & kategori (Terproteksi JWT)
app.get('/api/my-transactions', async (req, res) => {
    try {
        const user = await getUserIdFromToken(req);
        if (!user) {
            return res.status(401).json({ message: "Anda harus login terlebih dahulu!" });
        }
        
        const { data, error } = await supabase
            .from('transactions')
            .select('*, ticket_categories(*, events(*))')
            .eq('customer_email', user.email)
            .order('created_at', { ascending: false });
            
        if (error) {
            console.error("Gagal mengambil transaksi user:", error);
            return res.status(500).json({ error: "Gagal mengambil riwayat transaksi" });
        }
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 7. API: Validasi Scan Barcode di Pintu Masuk Event (Gate App)
app.post('/api/validate-ticket', async (req, res) => {
    try {
        const { ticketCode } = req.body;

        const { data: ticket, error } = await supabase.from('transactions')
            .select('*, ticket_categories(category_name)').eq('ticket_code', ticketCode).single();

        if (error || !ticket) return res.status(404).json({ message: "Tiket Palsu / Tidak Terdaftar!" });
        if (ticket.status === 'USED') return res.status(400).json({ message: "DITOLAK! Tiket sudah pernah dipakai masuk!" });
        if (ticket.status !== 'PAID') return res.status(400).json({ message: "DITOLAK! Status tiket tidak valid/belum lunas." });

        // Update status tiket menjadi 'USED'
        await supabase.from('transactions').update({ status: 'USED' }).eq('ticket_code', ticketCode);
        res.json({ customer_name: ticket.customer_name, category_name: ticket.ticket_categories.category_name });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



app.get('/', (req, res) => {
  res.send('Server Node.js berhasil berjalan di Vercel!');
});

// PENTING: Export app untuk Vercel
module.exports = app; 

// Jalankan server di lokal (opsional/kondisional)
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}
