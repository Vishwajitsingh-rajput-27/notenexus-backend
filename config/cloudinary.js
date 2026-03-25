const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// PDFs MUST use resource_type 'image' (not 'raw') so that Cloudinary's
// pg_N page-render transformation works for OCR on scanned PDFs.
// Audio/other files use 'auto'.
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const isPDF   = file.mimetype === 'application/pdf';
    const isAudio = ['audio/mpeg', 'audio/wav', 'audio/x-m4a', 'audio/webm'].includes(file.mimetype);
    return {
      folder:        'notenexus',
      // PDFs should be 'raw' to avoid 401/403 errors when fetching back the original file.
      // 'image' is only needed if using Cloudinary's pg_N transformations.
      resource_type: isAudio ? 'video' : (isPDF ? 'raw' : 'image'),
      allowed_formats: ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'mp3', 'wav', 'm4a', 'webm'],
    };
  },
});

const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } }); // 25 MB

module.exports = { cloudinary, upload };
