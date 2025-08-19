const express = require('express');
const router = express.Router();

const authController = require('../controllers/authController');
const medicoController = require('../controllers/medicoController');
const consultaController = require('../controllers/consultaController');
const multer = require('multer');
const multerConfig = require('../config/multerConfig');
const exameController = require('../controllers/exameController');
const pacienteController = require('../controllers/pacienteController');

const upload = multer(multerConfig); // Vamos criar este
// ... importe outros controllers

const authMiddleware = require('../middleware/auth');

// Rotas Públicas (não precisam de login)
router.post('/auth/register', authController.register);
router.post('/auth/login', authController.login);

// --- A partir daqui, todas as rotas precisam de login ---
router.use(authMiddleware);
router.post('/consultas', consultaController.agendarConsulta);

// Rotas de Médicos (exemplo de rota protegida)
router.get('/medicos', medicoController.getAllMedicos);
router.post('/exames/upload', upload.single('exame'), exameController.uploadExame);
router.get('/consultas/minha-agenda', consultaController.getMinhaAgenda);
router.get('/pacientes/:id', pacienteController.getPacienteDetails);
router.put('/consultas/:id/status', consultaController.updateStatusConsulta);
router.delete('/consultas/:id', consultaController.cancelarConsulta);
// Dentro das rotas protegidas

// router.post('/medicos', medicoController.createMedico); // Exemplo para secretária

// Rotas de Consultas
// router.post('/consultas', consultaController.agendarConsulta); // Rota para paciente agendar
// router.get('/consultas/medico', consultaController.getConsultasMedico); // Rota para médico ver agenda

// ... outras rotas protegidas

module.exports = router;