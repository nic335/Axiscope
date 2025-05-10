#!/bin/bash

# Default values
AXISCOPE_ENV="axiscope-env"
INSTALL_DIR="$HOME/axiscope"
SERVICE_NAME="axiscope.service"
MOONRAKER_CONF="$HOME/printer_data/config/moonraker.conf"
MOONRAKER_ASVC="$HOME/printer_data/moonraker.asvc"

echo "Uninstalling AxisScope..."

# Stop and disable the service
echo "Stopping and disabling AxisScope service..."
sudo systemctl stop ${SERVICE_NAME} 2>/dev/null || true
sudo systemctl disable ${SERVICE_NAME} 2>/dev/null || true

# Remove service file
echo "Removing service file..."
sudo rm -f /etc/systemd/system/${SERVICE_NAME}
sudo systemctl daemon-reload

# Deactivate virtual environment if active
if [ -n "$VIRTUAL_ENV" ]; then
    echo "Deactivating virtual environment..."
    deactivate
fi

# Remove installation directory
if [ -d "${INSTALL_DIR}" ]; then
    echo "Removing installation directory..."
    rm -rf "${INSTALL_DIR}"
fi

# Check for backup and offer to remove it
if [ -d "${INSTALL_DIR}.bak" ]; then
    read -p "Backup directory found at ${INSTALL_DIR}.bak. Remove it? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "Removing backup directory..."
        rm -rf "${INSTALL_DIR}.bak"
    fi
fi

# Remove from moonraker.asvc
if [ -f "${MOONRAKER_ASVC}" ]; then
    echo "Removing from moonraker.asvc..."
    sed -i '/^axiscope$/d' "${MOONRAKER_ASVC}"
fi

# Remove update manager configuration from moonraker.conf
if [ -f "${MOONRAKER_CONF}" ]; then
    echo "Removing update manager configuration..."
    sed -i '/\[update_manager axiscope\]/,/\[\|^$/!{/\[update_manager axiscope\]/,/^$/d}' "${MOONRAKER_CONF}"
fi

# Remove symlink from klipper extras
echo "Removing symlink from klipper extras..."
if [ -L "${HOME}/klipper/klippy/extras/axiscope.py" ]; then
    sudo rm -f "${HOME}/klipper/klippy/extras/axiscope.py"
fi

# Restart services
echo "Restarting services..."
sudo systemctl restart moonraker
sudo systemctl restart klipper

echo "AxisScope has been uninstalled successfully!"
