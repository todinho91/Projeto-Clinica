const express = require('express');
const multer = require('multer');
const authController = require('../controllers/authController');
const consultaController = require('../controllers/consultaController');
const exameController = require('../controllers/exameController');
const especialidadeController = require('../controllers/especialidadeController');
const medicoController = require('../controllers/medicoController');
const pacienteController = require('../controllers/pacienteController');
const equipeController = require('../controllers/equipeController');
const clinicaController = require('../controllers/clinicaController');
const disponibilidadeController = require('../controllers/disponibilidadeController');
const multerConfig = require('../config/multerConfig');
const authenticate = require('../middleware/auth');
const identityOnly = require('../middleware/identityOnly');
const tenantContext = require('../middleware/tenant');
const authorize = require('../middleware/authorize');
const optionalAuth = require('../middleware/optionalAuth');
const invitationRateLimit = require('../middleware/invitationRateLimit');

const router = express.Router();
const upload = multer(multerConfig);

router.post('/auth/register', authController.register);
router.post('/auth/login', authController.login);
router.get('/convites/:token', invitationRateLimit, equipeController.inspectInvitation);
router.post('/convites/:token/aceitar', invitationRateLimit, optionalAuth, equipeController.acceptInvitation);

router.use(authenticate);
router.get('/auth/clinics', identityOnly, authController.listClinics);
router.post('/auth/select-clinic', identityOnly, authController.selectClinic);
router.get('/plataforma/capacidades', identityOnly, clinicaController.capabilities);
router.get('/plataforma/clinicas', identityOnly, clinicaController.listPlatformClinics);
router.post('/plataforma/clinicas', identityOnly, clinicaController.provision);
router.post(
    '/plataforma/clinicas/:clinicId/convites/:invitationId/reenviar',
    identityOnly,
    clinicaController.reissueInitialInvitation
);

router.use(tenantContext);

router.get('/clinica/configuracoes', authorize('administrador'), clinicaController.getSettings);
router.patch('/clinica/configuracoes', authorize('administrador'), clinicaController.updateSettings);

router.get('/equipe', authorize('administrador', 'secretaria'), equipeController.list);
router.post('/equipe/convites', authorize('administrador', 'secretaria'), equipeController.createInvitation);
router.post('/equipe/convites/:id/reenviar', authorize('administrador', 'secretaria'), equipeController.reissue);
router.post('/equipe/convites/:id/revogar', authorize('administrador', 'secretaria'), equipeController.revoke);
router.patch('/equipe/vinculos/:id/status', authorize('administrador', 'secretaria'), equipeController.updateStatus);
router.patch('/equipe/vinculos/:id/papel', authorize('administrador'), equipeController.updateRole);

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
router.post(
    '/profissionais/cadastro-completo',
    authorize('administrador', 'secretaria'),
    medicoController.createProfessionalAccount
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
router.get(
    '/disponibilidade/contexto',
    authorize('administrador', 'secretaria', 'profissional'),
    disponibilidadeController.context
);
router.get(
    '/disponibilidade/profissionais/:professionalId',
    authorize('administrador', 'secretaria', 'profissional'),
    disponibilidadeController.getProfessionalAvailability
);
router.put(
    '/disponibilidade/profissionais/:professionalId/semana',
    authorize('administrador', 'secretaria', 'profissional'),
    disponibilidadeController.replaceWeeklyAvailability
);
router.post(
    '/disponibilidade/profissionais/:professionalId/bloqueios',
    authorize('administrador', 'secretaria', 'profissional'),
    disponibilidadeController.createBlock
);
router.patch(
    '/disponibilidade/profissionais/:professionalId/bloqueios/:blockId/cancelar',
    authorize('administrador', 'secretaria', 'profissional'),
    disponibilidadeController.cancelBlock
);
router.post(
    '/consultas',
    authorize('administrador', 'secretaria', 'paciente'),
    consultaController.agendarConsulta
);
router.get(
    '/consultas/contexto',
    authorize('administrador', 'secretaria', 'paciente'),
    consultaController.context
);
router.get(
    '/consultas/horarios',
    authorize('administrador', 'secretaria', 'paciente'),
    consultaController.availableSlots
);
router.get(
    '/consultas/gestao',
    authorize('administrador', 'secretaria'),
    consultaController.listForManagement
);
router.get(
    '/consultas/minha-agenda',
    authorize('administrador', 'secretaria', 'profissional', 'paciente'),
    consultaController.getMinhaAgenda
);
router.put(
    '/consultas/:id/status',
    authorize('administrador', 'secretaria'),
    consultaController.updateStatusConsulta
);
router.put(
    '/consultas/:id/concluir',
    authorize('profissional'),
    consultaController.concluirAtendimento
);
router.patch(
    '/consultas/:id/reagendar',
    authorize('administrador', 'secretaria'),
    consultaController.reschedule
);
router.get(
    '/consultas/:id/historico',
    authorize('administrador', 'secretaria', 'profissional'),
    consultaController.getHistory
);
router.delete(
    '/consultas/:id',
    authorize('administrador', 'secretaria', 'paciente'),
    consultaController.cancelarConsulta
);
router.get(
    '/pacientes/gestao',
    authorize('administrador', 'secretaria'),
    pacienteController.listForManagement
);
router.get(
    '/pacientes/busca',
    authorize('administrador', 'secretaria'),
    pacienteController.searchForScheduling
);
router.get(
    '/pacientes/gestao/:id',
    authorize('administrador', 'secretaria'),
    pacienteController.getForManagement
);
router.post(
    '/pacientes/duplicidades',
    authorize('administrador', 'secretaria'),
    pacienteController.previewDuplicates
);
router.post(
    '/pacientes',
    authorize('administrador', 'secretaria'),
    pacienteController.createPatient
);
router.put(
    '/pacientes/:id',
    authorize('administrador', 'secretaria'),
    pacienteController.updatePatient
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
