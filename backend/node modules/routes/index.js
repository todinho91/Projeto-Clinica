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
const confirmacaoConsultaController = require('../controllers/confirmacaoConsultaController');
const consultorioController = require('../controllers/consultorioController');
const multerConfig = require('../config/multerConfig');
const authenticate = require('../middleware/auth');
const identityOnly = require('../middleware/identityOnly');
const tenantContext = require('../middleware/tenant');
const authorize = require('../middleware/authorize');
const workspaceManager = require('../middleware/workspaceManager');
const practiceTeamManager = require('../middleware/practiceTeamManager');
const institutionalOnly = require('../middleware/institutionalOnly');
const optionalAuth = require('../middleware/optionalAuth');
const invitationRateLimit = require('../middleware/invitationRateLimit');

const router = express.Router();
const upload = multer(multerConfig);

router.post('/auth/register', authController.register);
router.post('/auth/register-professional', authController.registerProfessional);
router.post('/auth/login', authController.login);
router.get('/convites/:token', invitationRateLimit, equipeController.inspectInvitation);
router.post('/convites/:token/aceitar', invitationRateLimit, optionalAuth, equipeController.acceptInvitation);
function protectPublicConfirmation(req, res, next) {
    res.set({
        'Cache-Control': 'no-store, private, max-age=0',
        Pragma: 'no-cache',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex, nofollow, noarchive'
    });
    next();
}

router.post(
    '/confirmacoes-consulta/consultar',
    invitationRateLimit,
    protectPublicConfirmation,
    confirmacaoConsultaController.inspectPublic
);
router.post(
    '/confirmacoes-consulta/responder',
    invitationRateLimit,
    protectPublicConfirmation,
    confirmacaoConsultaController.respondPublic
);

router.use(authenticate);
router.get('/auth/clinics', identityOnly, authController.listClinics);
router.post('/auth/select-clinic', identityOnly, authController.selectClinic);
router.get('/plataforma/capacidades', identityOnly, clinicaController.capabilities);
router.get('/plataforma/clinicas', identityOnly, clinicaController.listPlatformClinics);
router.post('/plataforma/clinicas', identityOnly, clinicaController.provision);
router.get('/profissionais/identidade', identityOnly, consultorioController.getIdentity);
router.post('/profissionais/identidade', identityOnly, consultorioController.createIdentity);
router.patch(
    '/plataforma/profissionais/:userId/verificacao',
    identityOnly,
    consultorioController.verifyIdentity
);
router.get(
    '/plataforma/profissionais/verificacoes',
    identityOnly,
    consultorioController.listIdentityReviews
);
router.post('/consultorios', identityOnly, consultorioController.provision);
router.post(
    '/plataforma/clinicas/:clinicId/convites/:invitationId/reenviar',
    identityOnly,
    clinicaController.reissueInitialInvitation
);

router.use(tenantContext);

router.get('/consultorio/contexto', authorize('profissional'), consultorioController.context);
router.post('/consultorio/locais', authorize('profissional'), consultorioController.createLocation);
router.patch(
    '/consultorio/locais/:id/status',
    authorize('profissional'),
    consultorioController.updateLocationStatus
);

router.get('/clinica/configuracoes', workspaceManager('administrador'), clinicaController.getSettings);
router.patch('/clinica/configuracoes', workspaceManager('administrador'), clinicaController.updateSettings);

router.get('/equipe', practiceTeamManager, equipeController.list);
router.post('/equipe/convites', practiceTeamManager, equipeController.createInvitation);
router.post('/equipe/convites/:id/reenviar', practiceTeamManager, equipeController.reissue);
router.post('/equipe/convites/:id/revogar', practiceTeamManager, equipeController.revoke);
router.patch('/equipe/vinculos/:id/status', practiceTeamManager, equipeController.updateStatus);
router.patch('/equipe/vinculos/:id/papel', institutionalOnly('administrador'), equipeController.updateRole);

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
    institutionalOnly('administrador', 'secretaria'),
    medicoController.listForManagement
);
router.get(
    '/profissionais/opcoes',
    institutionalOnly('administrador', 'secretaria'),
    medicoController.getManagementOptions
);
router.post(
    '/profissionais',
    institutionalOnly('administrador', 'secretaria'),
    medicoController.createProfessional
);
router.post(
    '/profissionais/cadastro-completo',
    institutionalOnly('administrador', 'secretaria'),
    medicoController.createProfessionalAccount
);
router.put(
    '/profissionais/:id',
    institutionalOnly('administrador', 'secretaria'),
    medicoController.updateProfessional
);
router.patch(
    '/profissionais/:id/status',
    institutionalOnly('administrador', 'secretaria'),
    medicoController.updateProfessionalStatus
);
router.get(
    '/especialidades/gestao',
    workspaceManager('administrador', 'secretaria'),
    especialidadeController.listForManagement
);
router.post(
    '/especialidades',
    workspaceManager('administrador', 'secretaria'),
    especialidadeController.createSpecialty
);
router.put(
    '/especialidades/:id',
    workspaceManager('administrador', 'secretaria'),
    especialidadeController.updateSpecialty
);
router.patch(
    '/especialidades/:id/status',
    workspaceManager('administrador', 'secretaria'),
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
    workspaceManager('administrador', 'secretaria', 'paciente'),
    consultaController.agendarConsulta
);
router.get(
    '/consultas/contexto',
    workspaceManager('administrador', 'secretaria', 'paciente'),
    consultaController.context
);
router.get(
    '/consultas/horarios',
    workspaceManager('administrador', 'secretaria', 'paciente'),
    consultaController.availableSlots
);
router.get(
    '/consultas/gestao',
    workspaceManager('administrador', 'secretaria'),
    consultaController.listForManagement
);
router.get(
    '/consultas/calendario/contexto',
    authorize('administrador', 'secretaria', 'profissional'),
    consultaController.calendarContext
);
router.get(
    '/consultas/calendario',
    authorize('administrador', 'secretaria', 'profissional'),
    consultaController.listCalendar
);
router.get(
    '/consultas/minha-agenda',
    authorize('administrador', 'secretaria', 'profissional', 'paciente'),
    consultaController.getMinhaAgenda
);
router.put(
    '/consultas/:id/status',
    workspaceManager('administrador', 'secretaria'),
    consultaController.updateStatusConsulta
);
router.put(
    '/consultas/:id/concluir',
    authorize('profissional'),
    consultaController.concluirAtendimento
);
router.patch(
    '/consultas/:id/reagendar',
    workspaceManager('administrador', 'secretaria'),
    consultaController.reschedule
);
router.get(
    '/consultas/:id/historico',
    authorize('administrador', 'secretaria', 'profissional'),
    consultaController.getHistory
);
router.post(
    '/consultas/:id/confirmacoes',
    workspaceManager('administrador', 'secretaria'),
    confirmacaoConsultaController.requestConfirmation
);
router.post(
    '/consultas/:id/confirmacoes/manual',
    workspaceManager('administrador', 'secretaria'),
    confirmacaoConsultaController.manualResponse
);
router.post(
    '/consultas/:id/confirmacoes/minha-resposta',
    authorize('paciente'),
    confirmacaoConsultaController.authenticatedPatientResponse
);
router.get(
    '/confirmacoes/minhas-preferencias',
    authorize('paciente'),
    confirmacaoConsultaController.getPatientChannelPreference
);
router.put(
    '/confirmacoes/minhas-preferencias',
    authorize('paciente'),
    confirmacaoConsultaController.updatePatientChannelPreference
);
router.get(
    '/consultas/:id/confirmacoes',
    workspaceManager('administrador', 'secretaria'),
    confirmacaoConsultaController.history
);
router.delete(
    '/consultas/:id',
    workspaceManager('administrador', 'secretaria', 'paciente'),
    consultaController.cancelarConsulta
);
router.get(
    '/pacientes/gestao',
    workspaceManager('administrador', 'secretaria'),
    pacienteController.listForManagement
);
router.get(
    '/pacientes/busca',
    workspaceManager('administrador', 'secretaria'),
    pacienteController.searchForScheduling
);
router.get(
    '/pacientes/gestao/:id',
    workspaceManager('administrador', 'secretaria'),
    pacienteController.getForManagement
);
router.post(
    '/pacientes/duplicidades',
    workspaceManager('administrador', 'secretaria'),
    pacienteController.previewDuplicates
);
router.post(
    '/pacientes',
    workspaceManager('administrador', 'secretaria'),
    pacienteController.createPatient
);
router.put(
    '/pacientes/:id',
    workspaceManager('administrador', 'secretaria'),
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
