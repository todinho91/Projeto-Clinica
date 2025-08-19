const multer = require('multer');
const path = require('path');

module.exports = {
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            // Define a pasta onde os arquivos serão salvos
            cb(null, path.resolve(__dirname, '..', '..', 'uploads'));
        },
        filename: (req, file, cb) => {
            // Garante que cada arquivo tenha um nome único (timestamp + nome original)
            const uniqueName = `${Date.now()}-${file.originalname}`;
            cb(null, uniqueName);
        }
    })
};