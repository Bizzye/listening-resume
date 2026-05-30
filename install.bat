@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

:: ============================================================================
:: Listening Resume — Instalador Windows
:: Grava, transcreve e resume áudio de qualquer fonte (videoaulas, reuniões, etc)
:: ============================================================================

echo.
echo ╔══════════════════════════════════════════════╗
echo ║       Listening Resume — Instalador          ║
echo ╚══════════════════════════════════════════════╝
echo.

:: ─── Verificar privilégios de admin (para winget/choco) ─────────────────────
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARN] Recomendado executar como Administrador para instalar dependencias.
    echo        Algumas instalacoes podem falhar sem privilegios elevados.
    echo.
    pause
)

:: ─── Verificar/instalar Node.js ─────────────────────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] Node.js nao encontrado. Instalando...
    
    where winget >nul 2>&1
    if %errorlevel% equ 0 (
        winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    ) else (
        where choco >nul 2>&1
        if %errorlevel% equ 0 (
            choco install nodejs-lts -y
        ) else (
            echo [ERROR] Instale o Node.js 20+ manualmente: https://nodejs.org
            echo         Depois execute este script novamente.
            pause
            exit /b 1
        )
    )
    
    :: Recarregar PATH
    call refreshenv 2>nul
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
) else (
    for /f "tokens=1 delims=v" %%a in ('node --version') do set NODE_VER=%%a
    echo [OK] Node.js encontrado
)

:: ─── Verificar/instalar pnpm ────────────────────────────────────────────────
where pnpm >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] Instalando pnpm...
    call npm install -g pnpm
    echo [OK] pnpm instalado
) else (
    echo [OK] pnpm encontrado
)

:: ─── Verificar/instalar FFmpeg ──────────────────────────────────────────────
where ffmpeg >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] FFmpeg nao encontrado. Instalando...
    
    where winget >nul 2>&1
    if %errorlevel% equ 0 (
        winget install Gyan.FFmpeg --accept-package-agreements --accept-source-agreements
    ) else (
        where choco >nul 2>&1
        if %errorlevel% equ 0 (
            choco install ffmpeg -y
        ) else (
            echo [WARN] Instale FFmpeg manualmente: https://ffmpeg.org/download.html
            echo        Adicione ao PATH e execute este script novamente.
        )
    )
) else (
    echo [OK] FFmpeg encontrado
)

:: ─── Verificar/instalar Ollama ──────────────────────────────────────────────
where ollama >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] Ollama nao encontrado. Instalando...
    
    where winget >nul 2>&1
    if %errorlevel% equ 0 (
        winget install Ollama.Ollama --accept-package-agreements --accept-source-agreements
    ) else (
        echo [WARN] Instale Ollama manualmente: https://ollama.com/download/windows
    )
) else (
    echo [OK] Ollama encontrado
)

:: ─── Baixar modelo LLM ─────────────────────────────────────────────────────
where ollama >nul 2>&1
if %errorlevel% equ 0 (
    echo [INFO] Baixando modelo llama3.1:8b (pode demorar na primeira vez)...
    ollama pull llama3.1:8b
    if %errorlevel% equ 0 (
        echo [OK] Modelo llama3.1:8b pronto
    ) else (
        echo [WARN] Nao foi possivel baixar o modelo agora.
        echo        Execute depois: ollama pull llama3.1:8b
    )
)

:: ─── Instalar o aplicativo ─────────────────────────────────────────────────
set "INSTALL_DIR=%LOCALAPPDATA%\listening-resume"

if exist "%INSTALL_DIR%\package.json" (
    echo [INFO] Atualizando instalacao existente...
    cd /d "%INSTALL_DIR%"
) else (
    echo [INFO] Instalando em %INSTALL_DIR%...
    
    :: Copiar do diretório atual
    if exist "%~dp0package.json" (
        xcopy "%~dp0" "%INSTALL_DIR%\" /E /I /H /Y /Q >nul 2>&1
        cd /d "%INSTALL_DIR%"
    ) else (
        echo [ERROR] Execute este script de dentro do repositorio do projeto.
        pause
        exit /b 1
    )
)

echo [INFO] Instalando dependencias Node.js...
call pnpm install
if %errorlevel% neq 0 (
    echo [ERROR] Falha ao instalar dependencias.
    pause
    exit /b 1
)

echo [INFO] Compilando...
call pnpm build
if %errorlevel% neq 0 (
    echo [ERROR] Falha na compilacao.
    pause
    exit /b 1
)

echo [OK] Aplicativo compilado

:: ─── Criar scripts de inicialização ─────────────────────────────────────────
set "BIN_DIR=%LOCALAPPDATA%\listening-resume\bin"
mkdir "%BIN_DIR%" 2>nul

:: CLI launcher
(
echo @echo off
echo cd /d "%INSTALL_DIR%"
echo call pnpm listen %%*
) > "%BIN_DIR%\listening-resume.cmd"

:: GUI launcher
(
echo @echo off
echo cd /d "%INSTALL_DIR%\apps\gui"
echo call pnpm dev
) > "%BIN_DIR%\listening-resume-gui.cmd"

:: Adicionar ao PATH do usuário
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "CURRENT_PATH=%%b"
echo !CURRENT_PATH! | findstr /i /c:"%BIN_DIR%" >nul 2>&1
if %errorlevel% neq 0 (
    setx PATH "%CURRENT_PATH%;%BIN_DIR%" >nul 2>&1
    echo [OK] Adicionado ao PATH: %BIN_DIR%
    echo [WARN] Feche e reabra o terminal para usar os comandos.
) else (
    echo [OK] PATH ja configurado
)

:: ─── Configuração inicial ───────────────────────────────────────────────────
set "CONFIG_DIR=%APPDATA%\listening-resume"
mkdir "%CONFIG_DIR%" 2>nul

if not exist "%CONFIG_DIR%\config.toml" (
    (
echo [audio]
echo device = "default"
echo.
echo [transcription]
echo provider = "groq"
echo model = "whisper-large-v3-turbo"
echo.
echo [analysis]
echo provider = "ollama"
echo model = "llama3.1:8b"
echo defaultTemplate = "meeting-summary"
    ) > "%CONFIG_DIR%\config.toml"
    echo [OK] Configuracao padrao criada em %CONFIG_DIR%\config.toml
) else (
    echo [OK] Configuracao existente mantida
)

:: ─── Verificações finais ───────────────────────────────────────────────────
echo.
echo ══════════════════════════════════════════════════
echo   Instalacao concluida!
echo ══════════════════════════════════════════════════
echo.
echo  Verificacao:

where ffmpeg >nul 2>&1 && (echo   [OK] FFmpeg) || (echo   [X] FFmpeg - instale manualmente)
where node >nul 2>&1 && (echo   [OK] Node.js) || (echo   [X] Node.js)
where pnpm >nul 2>&1 && (echo   [OK] pnpm) || (echo   [X] pnpm)
where ollama >nul 2>&1 && (echo   [OK] Ollama) || (echo   [X] Ollama)

echo.
echo  Proximos passos:
echo   1. Configure a chave Groq na interface (Settings ^> Groq API Key)
echo      ou obtenha em: https://console.groq.com/keys
echo   2. Inicie a interface: listening-resume-gui
echo   3. Ou use o CLI: listening-resume record
echo.
echo  NOTA Windows: O audio e capturado via loopback do dispositivo padrao.
echo  Certifique-se de que o "Stereo Mix" esta habilitado nas configuracoes
echo  de som do Windows (Painel de Controle ^> Som ^> Gravacao).
echo.

pause
