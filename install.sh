#!/bin/bash

# Default values
AXISCOPE_ENV="axiscope-env"
INSTALL_DIR="$HOME/axiscope"
REPO_URL="https://github.com/nic335/Axiscope.git"
BRANCH="main"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --branch)
            BRANCH="$2"
            shift 2
            ;;
        *)
            echo "Unknown parameter: $1"
            exit 1
            ;;
    esac
done

echo "Installing AxisScope..."
echo "Using branch: ${BRANCH}"

# Check for existing installation
if [ -d "${INSTALL_DIR}" ]; then
    echo "Existing installation found at ${INSTALL_DIR}"
    echo "Backing up..."
    mv "${INSTALL_DIR}" "${INSTALL_DIR}.bak"
fi

# Clone repository
echo "Cloning AxisScope repository..."
git clone -b ${BRANCH} ${REPO_URL} ${INSTALL_DIR}

# Check if running as root
if [ "$EUID" -eq 0 ]; then 
    echo "Please do not run as root/sudo. Installation will prompt for sudo when needed."
    exit 1
fi

# Check for python3-venv
echo "Checking for python3-venv..."
if ! dpkg -l | grep -q python3-venv; then
    echo "python3-venv not found. Installing..."
    sudo apt-get update || {
        echo "Failed to update package list"
        exit 1
    }
    sudo apt-get install -y python3-venv || {
        echo "Failed to install python3-venv"
        exit 1
    }
    echo "python3-venv installed successfully"
else
    echo "python3-venv is already installed"
fi

# Verify python3 -m venv works
echo "Verifying python3 venv functionality..."
python3 -m venv --help > /dev/null 2>&1 || {
    echo "Error: python3 venv module not working properly"
    echo "Trying to fix by reinstalling..."
    sudo apt-get install --reinstall python3-venv || {
        echo "Failed to reinstall python3-venv"
        exit 1
    }
}

# Create and activate virtual environment
echo "Setting up Python virtual environment..."
python3 -m venv "${INSTALL_DIR}/${AXISCOPE_ENV}" || {
    echo "Failed to create virtual environment"
    echo "Python version: $(python3 --version)"
    echo "Venv version: $(dpkg -l | grep python3-venv)"
    exit 1
}

if [ ! -f "${INSTALL_DIR}/${AXISCOPE_ENV}/bin/activate" ]; then
    echo "Virtual environment files not created properly"
    exit 1
fi

echo "Activating virtual environment..."
source "${INSTALL_DIR}/${AXISCOPE_ENV}/bin/activate" || {
    echo "Failed to activate virtual environment"
    exit 1
}

# Verify activation
if [[ "$VIRTUAL_ENV" != "${INSTALL_DIR}/${AXISCOPE_ENV}" ]]; then
    echo "Virtual environment not activated correctly"
    exit 1
fi

# Install Python dependencies
echo "Installing Python dependencies..."
pip install --upgrade pip
pip install flask waitress  # Install Flask and Waitress WSGI server

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

# Copy service file
echo "Installing AxisScope service..."
sed -i "s/\$USER/${USER}/g; s/\$HOME/${HOME//\//\\/}/g" "${INSTALL_DIR}/axiscope.service"
sudo cp "${INSTALL_DIR}/axiscope.service" /etc/systemd/system/
sudo systemctl daemon-reload

# Add to moonraker allowed services
echo "Adding to moonraker.asvc..."
ASVC_FILE="${HOME}/printer_data/moonraker.asvc"

# Create file if it doesn't exist
if [ ! -f "${ASVC_FILE}" ]; then
    touch "${ASVC_FILE}"
fi

# Check if axiscope is already in the file
if ! grep -q "^axiscope$" "${ASVC_FILE}"; then
    # Ensure there's a newline at the end of file
    [ -s "${ASVC_FILE}" ] && echo >> "${ASVC_FILE}"
    # Add axiscope
    echo "axiscope" >> "${ASVC_FILE}"
    echo "Added axiscope to moonraker.asvc"
else
    echo "axiscope already in moonraker.asvc"
fi

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
primary_branch: ${BRANCH}
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

# Reload systemd and enable the service
echo "Reloading systemd..."
sudo systemctl daemon-reload

# Enable and start the service
echo "Enabling and starting AxisScope service..."
sudo systemctl enable axiscope.service
# sudo systemctl start axiscope.service

# Restart moonraker to recognize the new service
echo "Restarting moonraker to recognize the new service..."
sudo systemctl restart moonraker

echo "Installation complete!"
echo "AxisScope service has been enabled and started"
echo "The service can be controlled through Mainsail's service control popup"
echo "When running, it will be hosted at YourPrinterIP:3000"