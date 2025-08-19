// ======================================================
// CONFIGURAÇÕES E FUNÇÕES GLOBAIS
// ======================================================
const API_URL = 'http://localhost:3000/api';

// Verifica se o usuário está logado em páginas protegidas
function checkAuth() {
    const token = localStorage.getItem('authToken');
    if (!token) {
        window.location.href = 'login.html';
    }
    return token;
}

// Função de Logout
function logout() {
    localStorage.removeItem('authToken');
    window.location.href = 'login.html';
}

// ======================================================
// ROTEADOR PRINCIPAL - Decide o que carregar
// ======================================================
document.addEventListener('DOMContentLoaded', () => {
    const path = window.location.pathname.split('/').pop();

    // Botão de logout existe em todas as páginas de dashboard
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) {
        logoutButton.addEventListener('click', logout);
    }

    // Executa a função específica da página atual
    if (path === 'login.html' || path === '') {
        setupLoginPage();
    } else if (path === 'register.html') { 
        setupRegisterPage();              
    } else if (path === 'dashboard-paciente.html') {
        setupPacienteDashboard();
    } else if (path === 'dashboard-medico.html') {
        setupMedicoDashboard();
    } else if (path === 'dashboard-secretaria.html') {
        setupSecretariaDashboard();
    }
});
// ======================================================
// LÓGICA ESPECÍFICA PARA A PÁGINA DE CADASTRO (NOVA FUNÇÃO)
// ======================================================
function setupRegisterPage() {
    const registerForm = document.getElementById('register-form');
    if (!registerForm) return;

    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const nome = document.getElementById('nome').value;
        const email = document.getElementById('email').value;
        const senha = document.getElementById('senha').value;
        const statusMessage = document.getElementById('status-message');
        
        // Note que definimos o "tipo" como "paciente" diretamente no código.
        // Isso garante que apenas pacientes possam se cadastrar através desta página pública.
        const tipo = 'paciente'; 

        try {
            const response = await fetch(`${API_URL}/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nome, email, senha, tipo })
            });

            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Erro ao cadastrar.');

            // Se o cadastro for bem-sucedido:
            statusMessage.className = 'text-success';
            statusMessage.textContent = data.message + ' Redirecionando para o login...';
            
            // Espera 3 segundos e redireciona para a página de login
            setTimeout(() => {
                window.location.href = 'login.html';
            }, 3000);

        } catch (error) {
            statusMessage.className = 'text-danger';
            statusMessage.textContent = error.message;
        }
    });
}

// ======================================================
// LÓGICA DA PÁGINA DE LOGIN
// ======================================================
function setupLoginPage() {
    const loginForm = document.getElementById('login-form');
    if (!loginForm) return; // Se o formulário não existir, para aqui

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('email').value;
        const senha = document.getElementById('senha').value;
        const errorMessage = document.getElementById('error-message');
        errorMessage.textContent = ''; // Limpa erros antigos

        try {
            const response = await fetch(`${API_URL}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, senha })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error);

            localStorage.setItem('authToken', data.token);

            switch (data.tipo) {
                case 'paciente':
                    window.location.href = 'dashboard-paciente.html';
                    break;
                case 'secretaria':
                    window.location.href = 'dashboard-secretaria.html';
                    break;
                case 'medico':
                    window.location.href = 'dashboard-medico.html';
                    break;
                default:
                    errorMessage.textContent = 'Tipo de usuário desconhecido.';
            }
        } catch (error) {
            errorMessage.textContent = error.message;
        }
    });
}

// ======================================================
// LÓGICA DO DASHBOARD DO PACIENTE
// ======================================================
function setupPacienteDashboard() {
    const token = checkAuth();
    // Lógica para carregar consultas do paciente (você precisa criar a API e a tabela HTML)
    // Lógica para carregar médicos e agendar consulta (já fizemos)
}

// ======================================================
// LÓGICA DO DASHBOARD DO MÉDICO
// ======================================================
function setupMedicoDashboard() {
    const token = checkAuth();
    const tabelaAgenda = document.getElementById('tabela-agenda');
    if (!tabelaAgenda) return;

    fetch(`${API_URL}/consultas/minha-agenda`, {
        headers: { 'Authorization': `Bearer ${token}` }
    })
    .then(res => res.json())
    .then(agenda => {
        if (agenda.length === 0) {
            tabelaAgenda.innerHTML = '<tr><td colspan="3" class="text-center">Nenhuma consulta agendada.</td></tr>';
            return;
        }
        tabelaAgenda.innerHTML = ''; // Limpa a tabela
        agenda.forEach(consulta => {
            const dataFormatada = new Date(consulta.data_hora).toLocaleString('pt-BR');
            const row = `
                <tr>
                    <td>${dataFormatada}</td>
                    <td>${consulta.nome_paciente}</td>
                    <td><span class="badge bg-primary">${consulta.status}</span></td>
                </tr>
            `;
            tabelaAgenda.innerHTML += row;
        });
    })
    .catch(err => console.error('Erro ao buscar agenda:', err));
}


// ======================================================
// LÓGICA DO DASHBOARD DA SECRETÁRIA
// ======================================================
function setupSecretariaDashboard() {
    const token = checkAuth();
    const uploadForm = document.getElementById('upload-exame-form');
    if (!uploadForm) return;

    uploadForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const statusDiv = document.getElementById('upload-status');
        const formData = new FormData(uploadForm); // Pega todos os dados do form

        try {
            const response = await fetch(`${API_URL}/exames/upload`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: formData
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error);
            
            statusDiv.className = 'text-success';
            statusDiv.textContent = result.message;
            uploadForm.reset();
        } catch (error) {
            statusDiv.className = 'text-danger';
            statusDiv.textContent = error.message;
        }
    });
}

// ======================================================
// FUNÇÕES DE AÇÃO (Podem ser chamadas de qualquer página)
// ======================================================

async function marcarRealizada(consultaId) {
    // ... código da função ...
}

async function cancelarMinhaConsulta(consultaId) {
    // ... código da função ...
}