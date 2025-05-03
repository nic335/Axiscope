# AxisScope

A tool alignment interface for Klipper-based 3D printers, designed to help with tool offset calibration in multi-tool setups.


#### Camera Mount

- [XY Nozzle Alignment Camera Mount](https://www.printables.com/model/1099576-xy-nozzle-alignment-camera)
- USB extension cable (if needed)

### Print Settings
- Layer Height: 0.2mm recommended
- Infill: 40% or higher
- Material: PETG or ABS recommended (due to potential heat exposure)
- Supports: Required for camera mount overhangs

### Assembly Instructions

1. Print all parts from the [XY Nozzle Alignment Camera repository](https://www.printables.com/model/1099576-xy-nozzle-alignment-camera)
2. Follow the assembly guide provided in the Printables link
3. Mount the USB camera securely in the printed housing
4. Route the USB cable carefully to avoid interference with printer movement

## Software Installation

### Installation

```bash
curl -s https://raw.githubusercontent.com/nic335/Axiscope/main/install.sh | bash
```

The install script will:

- Create Python virtual environment
- Install required dependencies
- Set up the systemd service
- Configure Moonraker integration

### Starting AxisScope

1. Open your Mainsail interface
2. Go to the Machine tab
3. Find 'axiscope' in the services list
4. Use the Start/Stop button to control the service

Once started, access the interface at `http://your-printer-ip:3000`

**Requirements:**

- Klipper installed and running
- Moonraker configured
- SSH access to your printer

## Usage Guide

### Initial Setup

1. Access the web interface at `http://your-printer-ip:3000`
2. [Placeholder: Initial configuration steps]
3. [Placeholder: Any calibration needed]

### Tool Alignment Process

1. Home your printer
2. [Placeholder: Step-by-step alignment process]
3. [Placeholder: Tips for accurate alignment]

### Features

- Web-based interface
- Real-time tool position visualization
- Integration with Moonraker for updates

## Integration with Mainsail

AxisScope integrates directly with Mainsail:

- Appears in update manager
- Can be managed through Moonraker
- Automatic startup with your printer

## License

[Placeholder: License information]

## Credits

[Placeholder: Acknowledgments and credits]
