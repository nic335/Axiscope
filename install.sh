#!/bin/bash

AXISCOPE_ENV="axiscope-env"
INSTALL_DIR="$HOME/axiscope"

# GitHub configuration
REPO_URL="https://github.com/N3MI-DG/Axiscope.git"

echo "Installing AxisScope..."

# Check for existing installation
if [ -d "${INSTALL_DIR}" ]; then
    echo "Existing installation found at ${INSTALL_DIR}"
    echo "Backing up..."
    mv "${INSTALL_DIR}" "${INSTALL_DIR}.bak"
fi

# Clone repository
echo "Cloning AxisScope repository..."
git clone ${REPO_URL} ${INSTALL_DIR}

# Check if running as root
if [ "$EUID" -eq 0 ]; then 
    echo "Please do not run as root/sudo. Installation will prompt for sudo when needed."
    exit 1
fi

# Install python3-venv if not present
if ! command -v python3 -m venv &> /dev/null; then
    echo "Installing python3-venv..."
    sudo apt-get update
    sudo apt-get install -y python3-venv
fi

# Create and activate virtual environment
echo "Setting up Python virtual environment..."
python3 -m venv "${INSTALL_DIR}/${AXISCOPE_ENV}"
source "${INSTALL_DIR}/${AXISCOPE_ENV}/bin/activate"

# Install Python dependencies
echo "Installing Python dependencies..."
pip install --upgrade pip
pip install flask  # We'll use Flask instead of simple HTTP server for better features

# Create the service file
echo "Creating service file..."
cat > /tmp/axiscope.service << EOL
[Unit]
Description=AxisScope - Tool Alignment Interface for Klipper
After=network.target moonraker.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=$USER
WorkingDirectory=$HOME/axiscope
ExecStart=$HOME/axiscope/axiscope-env/bin/python3 -m flask run --host=0.0.0.0 --port=3000
Environment="PATH=$HOME/axiscope/axiscope-env/bin"
Environment="FLASK_APP=app.py"
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
EOL

# Install service file
echo "Installing service file..."
sudo mv /tmp/axiscope.service /etc/systemd/system/



# Add to moonraker allowed services
echo "Adding to moonraker.asvc..."
echo "axiscope" >> ~/printer_data/moonraker.asvc

# Add update manager configuration
echo "Adding update manager configuration..."
if [ -f ~/printer_data/config/moonraker.conf ]; then
    # Check if the section already exists
    if ! grep -q "\[update_manager axiscope\]" ~/printer_data/config/moonraker.conf; then
        cat >> ~/printer_data/config/moonraker.conf << EOL

[update_manager axiscope]
type: git_repo
path: ${INSTALL_DIR}
origin: ${REPO_URL}
primary_branch: main
is_system_service: True
managed_services: axiscope
EOL
        echo "Added update manager configuration to moonraker.conf"
    else
        echo "Update manager configuration already exists"
    fi
else
    echo "Warning: moonraker.conf not found in expected location"
fi

# Reload systemd to recognize the new service
echo "Reloading systemd..."
sudo systemctl daemon-reload

echo "Installation complete!"
echo "AxisScope service has been created but is not enabled or started"
echo "The service can be controlled through Mainsail's Machine tab"
echo "When running, it will be hosted at YourPrinterIP:3000"
