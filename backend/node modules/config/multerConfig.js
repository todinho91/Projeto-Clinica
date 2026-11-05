const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const multer = require('multer');

const uploadsRoot = path.resolve(__dirname, '..', '..', 'uploads');

module.exports = {
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
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
            const extension = path.extname(file.originalname).toLowerCase().slice(0, 10);
            return callback(null, `${randomUUID()}${extension}`);
        }
    })
};
