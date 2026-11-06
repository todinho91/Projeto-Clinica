const express = require('express');
const multer = require('multer');
const authController = require('../controllers/authController');
const consultaController = require('../controllers/consultaController');
const exameController = require('../controllers/exameController');
const especialidadeController = require('../controllers/especialidadeController');
const medicoController = require('../controllers/medicoController');
const pacienteController = require('../controllers/pacienteController');
const multerConfig = require('../config/multerConfig');
const authenticate = require('../middleware/auth');
const tenantContext = require('../middleware/tenant');
const authorize = require('../middleware/authorize');

const router = express.Router();
const upload = multer(multerConfig);

router.post('/auth/register', authController.register);
router.post('/auth/login', authController.login);

router.use(authenticate);
router.get('/auth/clinics', authController.listClinics);
router.post('/auth/select-clinic', authController.selectClinic);

router.use(tenantContext);

router.get(
    '/profissionais',
    authorize('administrador', 'secretaria', 'profissional', 'paciente'),
    medicoController.getAllMedicos
);
router.get(
    '/medicos',
    authorize('administrador', 'secretaria', 'profissional', 'paciente'),
    medicoController.getAllMedicos
);
router.get(
    '/profissionais/gestao',
    authorize('administrador', 'secretaria'),
    medicoController.listForManagement
);
router.get(
    '/profissionais/opcoes',
    authorize('administrador', 'secretaria'),
    medicoController.getManagementOptions
);
router.post(
    '/profissionais',
    authorize('administrador', 'secretaria'),
    medicoController.createProfessional
);
router.put(
    '/profissionais/:id',
    authorize('administrador', 'secretaria'),
    medicoController.updateProfessional
);
router.patch(
    '/profissionais/:id/status',
    authorize('administrador', 'secretaria'),
    medicoController.updateProfessionalStatus
);
router.get(
    '/especialidades/gestao',
    authorize('administrador', 'secretaria'),
    especialidadeController.listForManagement
);
router.post(
    '/especialidades',
    authorize('administrador', 'secretaria'),
    especialidadeController.createSpecialty
);
router.put(
    '/especialidades/:id',
    authorize('administrador', 'secretaria'),
    especialidadeController.updateSpecialty
);
router.patch(
    '/especialidades/:id/status',
    authorize('administrador', 'secretaria'),
    especialidadeController.updateSpecialtyStatus
);
router.post(
    '/consultas',
    authorize('administrador', 'secretaria', 'paciente'),
    consultaController.agendarConsulta
);
router.get(
    '/consultas/minha-agenda',
    authorize('administrador', 'secretaria', 'profissional', 'paciente'),
    consultaController.getMinhaAgenda
);
router.put(
    '/consultas/:id/status',
    authorize('administrador', 'secretaria', 'profissional'),
    consultaController.updateStatusConsulta
);
router.delete(
    '/consultas/:id',
    authorize('administrador', 'secretaria', 'paciente'),
    consultaController.cancelarConsulta
);
router.get(
    '/pacientes/:id',
    authorize('administrador', 'secretaria', 'profissional', 'paciente'),
    pacienteController.getPacienteDetails
);
router.post(
    '/documentos/upload',
    authorize('administrador', 'secretaria', 'profissional'),
    upload.single('documento'),
    exameController.uploadExame
);
router.post(
    '/exames/upload',
    authorize('administrador', 'secretaria', 'profissional'),
    upload.single('exame'),
    exameController.uploadExame
);

module.exports = router;
