const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'notenexus',
    resource_type: 'auto',
    allowed_formats: ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'mp3', 'wav', 'm4a', 'webm'],
  },
});

const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB

module.exports = { cloudinary, upload };
