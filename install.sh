#!/usr/bin/env bash
# ============================================================================
# Listening Resume — Instalador Linux
# Grava, transcreve e resume áudio de qualquer fonte (videoaulas, reuniões, etc)
# ============================================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════╗"
echo "║       Listening Resume — Instalador          ║"
echo "╚══════════════════════════════════════════════╝"
echo -e "${NC}"

# ─── Detectar distro ────────────────────────────────────────────────────────
detect_distro() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    echo "$ID"
  elif command -v lsb_release &>/dev/null; then
    lsb_release -si | tr '[:upper:]' '[:lower:]'
  else
    echo "unknown"
  fi
}

DISTRO=$(detect_distro)
info "Distro detectada: $DISTRO"

# ─── Instalar dependências de sistema ───────────────────────────────────────
install_system_deps() {
  info "Instalando dependências do sistema..."

  case "$DISTRO" in
    ubuntu|debian|pop|mint|linuxmint)
      sudo apt update -qq
      sudo apt install -y ffmpeg pipewire pipewire-pulse curl git
      ;;
    fedora)
      sudo dnf install -y ffmpeg pipewire pipewire-pulseaudio curl git
      ;;
    arch|manjaro|endeavouros)
      sudo pacman -Syu --noconfirm ffmpeg pipewire pipewire-pulse curl git
      ;;
    opensuse*|suse*)
      sudo zypper install -y ffmpeg pipewire pipewire-pulseaudio curl git
      ;;
    *)
      warn "Distro '$DISTRO' não reconhecida. Instale manualmente: ffmpeg, pipewire, curl, git"
      ;;
  esac

  ok "Dependências do sistema instaladas"
}

# ─── Verificar/instalar Node.js ─────────────────────────────────────────────
install_node() {
  if command -v node &>/dev/null; then
    NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VER" -ge 20 ]; then
      ok "Node.js $(node --version) encontrado"
      return
    fi
    warn "Node.js encontrado mas versão < 20. Atualizando..."
  fi

  info "Instalando Node.js 20 via nvm..."
  if ! command -v nvm &>/dev/null; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  fi
  nvm install 20
  nvm use 20
  ok "Node.js $(node --version) instalado"
}

# ─── Verificar/instalar pnpm ────────────────────────────────────────────────
install_pnpm() {
  if command -v pnpm &>/dev/null; then
    ok "pnpm $(pnpm --version) encontrado"
    return
  fi

  info "Instalando pnpm..."
  npm install -g pnpm
  ok "pnpm instalado"
}

# ─── Verificar/instalar Ollama ───────────────────────────────────────────────
install_ollama() {
  if command -v ollama &>/dev/null; then
    ok "Ollama encontrado"
  else
    info "Instalando Ollama (LLM local para análise)..."
    curl -fsSL https://ollama.com/install.sh | sh
    ok "Ollama instalado"
  fi

  # Baixar modelo padrão
  info "Baixando modelo llama3.1:8b (pode demorar na primeira vez)..."
  ollama pull llama3.1:8b || warn "Não foi possível baixar o modelo agora. Execute 'ollama pull llama3.1:8b' depois."
  ok "Modelo llama3.1:8b pronto"
}

# ─── Instalar o aplicativo ──────────────────────────────────────────────────
install_app() {
  INSTALL_DIR="${LISTENING_RESUME_DIR:-$HOME/.local/share/listening-resume/app}"

  if [ -d "$INSTALL_DIR/.git" ] || [ -f "$INSTALL_DIR/package.json" ]; then
    info "Atualizando instalação existente em $INSTALL_DIR..."
    cd "$INSTALL_DIR"
    git pull 2>/dev/null || true
  else
    info "Instalando em $INSTALL_DIR..."
    mkdir -p "$(dirname "$INSTALL_DIR")"

    # Se estamos rodando de dentro do repo, copiar
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ -f "$SCRIPT_DIR/package.json" ]; then
      cp -r "$SCRIPT_DIR" "$INSTALL_DIR"
    else
      error "Execute este script de dentro do repositório do projeto."
    fi
    cd "$INSTALL_DIR"
  fi

  info "Instalando dependências Node.js..."
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install
  
  info "Compilando..."
  pnpm build

  ok "Aplicativo compilado"
}

# ─── Criar comando global ───────────────────────────────────────────────────
create_launcher() {
  INSTALL_DIR="${LISTENING_RESUME_DIR:-$HOME/.local/share/listening-resume/app}"
  BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR"

  # CLI launcher
  cat > "$BIN_DIR/listening-resume" << EOF
#!/usr/bin/env bash
cd "$INSTALL_DIR"
exec pnpm listen "\$@"
EOF
  chmod +x "$BIN_DIR/listening-resume"

  # GUI launcher
  cat > "$BIN_DIR/listening-resume-gui" << EOF
#!/usr/bin/env bash
cd "$INSTALL_DIR/apps/gui"
exec pnpm dev
EOF
  chmod +x "$BIN_DIR/listening-resume-gui"

  # Desktop entry
  DESKTOP_DIR="$HOME/.local/share/applications"
  mkdir -p "$DESKTOP_DIR"
  cat > "$DESKTOP_DIR/listening-resume.desktop" << EOF
[Desktop Entry]
Name=Listening Resume
Comment=Grave, transcreva e resuma qualquer áudio
Exec=$BIN_DIR/listening-resume-gui
Type=Application
Categories=AudioVideo;Audio;Utility;
Terminal=false
StartupNotify=true
EOF

  ok "Comandos criados: 'listening-resume' (CLI) e 'listening-resume-gui' (Interface)"

  # Verificar PATH
  if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    warn "$BIN_DIR não está no PATH. Adicione ao seu .bashrc/.zshrc:"
    echo -e "  ${YELLOW}export PATH=\"\$HOME/.local/bin:\$PATH\"${NC}"
  fi
}

# ─── Configuração inicial ───────────────────────────────────────────────────
setup_config() {
  CONFIG_DIR="$HOME/.config/listening-resume"
  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"

  if [ ! -f "$CONFIG_DIR/config.toml" ]; then
    cat > "$CONFIG_DIR/config.toml" << 'EOF'
[audio]
device = "default.monitor"

[transcription]
provider = "groq"
model = "whisper-large-v3-turbo"

[analysis]
provider = "ollama"
model = "llama3.1:8b"
defaultTemplate = "meeting-summary"
EOF
    ok "Configuração padrão criada em $CONFIG_DIR/config.toml"
  else
    ok "Configuração existente mantida"
  fi
}

# ─── Verificações finais ────────────────────────────────────────────────────
verify_installation() {
  echo ""
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN} Instalação concluída!${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo " Verificação:"
  
  command -v ffmpeg &>/dev/null && echo -e "  ${GREEN}✓${NC} FFmpeg" || echo -e "  ${RED}✗${NC} FFmpeg"
  command -v node &>/dev/null && echo -e "  ${GREEN}✓${NC} Node.js $(node --version)" || echo -e "  ${RED}✗${NC} Node.js"
  command -v pnpm &>/dev/null && echo -e "  ${GREEN}✓${NC} pnpm" || echo -e "  ${RED}✗${NC} pnpm"
  command -v ollama &>/dev/null && echo -e "  ${GREEN}✓${NC} Ollama" || echo -e "  ${RED}✗${NC} Ollama"
  pactl info &>/dev/null 2>&1 && echo -e "  ${GREEN}✓${NC} PipeWire/PulseAudio" || echo -e "  ${RED}✗${NC} PipeWire/PulseAudio"
  
  echo ""
  echo " Próximos passos:"
  echo "  1. Configure a chave Groq na interface (Settings > Groq API Key)"
  echo "     ou obtenha em: https://console.groq.com/keys"
  echo "  2. Inicie a interface: listening-resume-gui"
  echo "  3. Ou use o CLI: listening-resume record"
  echo ""
}

# ─── Executar ────────────────────────────────────────────────────────────────
install_system_deps
install_node
install_pnpm
install_ollama
install_app
create_launcher
setup_config
verify_installation
