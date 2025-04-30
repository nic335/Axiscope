#!/bin/bash

# Set text colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}================================"
echo "Welcome to AxiScope Setup"
echo -e "================================${NC}"
echo

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check if Python is installed
if ! command_exists python3; then
    echo -e "${RED}Python 3 is not installed.${NC}"
    echo "Would you like to install Python now? [Y/n]"
    read -r choice
    
    if [[ "$choice" =~ ^[Yy]$ ]] || [[ -z "$choice" ]]; then
        echo "Installing Python 3..."
        
        # Detect package manager and install Python
        if command_exists apt-get; then
            sudo apt-get update
            sudo apt-get install -y python3
        elif command_exists dnf; then
            sudo dnf install -y python3
        elif command_exists yum; then
            sudo yum install -y python3
        elif command_exists pacman; then
            sudo pacman -Sy python
        else
            echo -e "${RED}Could not detect package manager. Please install Python manually.${NC}"
            echo "Visit: https://www.python.org/downloads/"
            exit 1
        fi
    else
        echo -e "${RED}Python is required to run AxiScope.${NC}"
        echo "Please install Python from your package manager or https://www.python.org/downloads/"
        exit 1
    fi
fi

# Get Python version
python_version=$(python3 --version 2>&1)
echo -e "${GREEN}Found: $python_version${NC}"

echo
echo "Starting AxiScope..."
echo

# Check if port 3000 is available
if command_exists lsof; then
    if lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null ; then
        echo -e "${RED}Port 3000 is already in use.${NC}"
        echo "Please free up port 3000 and try again."
        exit 1
    fi
fi

# Start the server
echo -e "${GREEN}Starting the web server on http://localhost:3000${NC}"
echo "Press Ctrl+C to stop the server"
echo

# Try to start the server
python3 -m http.server 3000 || {
    echo -e "${RED}Failed to start the web server.${NC}"
    echo "Please make sure port 3000 is not in use."
    exit 1
}
