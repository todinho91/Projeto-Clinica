const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const multer = require('multer');

const uploadsRoot = path.resolve(__dirname, '..', '..', 'uploads');
const allowedFiles = new Map([
    ['application/pdf', new Set(['.pdf'])],
    ['image/jpeg', new Set(['.jpg', '.jpeg'])],
    ['image/png', new Set(['.png'])]
]);

module.exports = {
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, callback) => {
        const extension = path.extname(file.originalname).toLowerCase();
        if (!allowedFiles.get(file.mimetype)?.has(extension)) {
            return callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
        }
        return callback(null, true);
    },
    storage: multer.diskStorage({
        destination: (req, file, callback) => {
            const clinicId = req.tenant?.clinicId;
            if (!Number.isSafeInteger(clinicId) || clinicId <= 0) {
                return callback(new Error('Clínica ativa ausente para o upload.'));
            }
            const destination = path.join(uploadsRoot, String(clinicId));
            fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
            return callback(null, destination);
        },
        filename: (req, file, callback) => {
            const extension = {
                'application/pdf': '.pdf',
                'image/jpeg': '.jpg',
                'image/png': '.png'
            }[file.mimetype];
            return callback(null, `${randomUUID()}${extension}`);
        }
    })
};
