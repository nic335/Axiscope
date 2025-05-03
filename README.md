# AxisScope

## What is AxisScope?

AxisScope is a specialized tool designed to simplify the XY calibration process for multi-tool 3D printers using camera-assisted alignment. It provides a streamlined interface for:

- Manual XY calibration using camera feedback
- Quick and precise T0 center alignment
- Easy tool position capture and comparison
- Rapid switching between tools for offset calibration

<img src="media/axiscope.png" alt="Alt text" width="500"/>

## Hardware Requirements

### 3D Printed Parts

The following parts are required for camera mounting:

- [\[Link to camera mount model on Printables/similar\]](https://www.printables.com/model/1099576-xy-nozzle-alignment-camera)
- OV9726 camera module


## Installation

**Requirements:**

- Klipper installed and running
- Moonraker configured
- SSH access to your printer



Quick installation using curl:

```bash
curl -sSL https://raw.githubusercontent.com/nic335/Axiscope/install.sh | bash
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
<img src="media/ServiceControl.png" alt="Alt text" width="250"/>

## Usage Guide

### Initial Setup

1. Initial SetupAccess the web interface at `http://your-printer-ip:3000`
2. Select the printer address you are trying to calibrate, ( will most likely be autofiled soon )
3. Select the camera to use
   1. Align `T0` perfectly center to the crosair
   2. Capture Position
   3. Change to `Tn`
      1. Re-Align to center and press X and Y in the side navigator 
      2. From there your new calculated offset should be 

<img style="padding-bottom: 10px;" src="media/axiscope.png" alt="Alt text" width="500"/><br/>
<img style="padding-bottom: 10px;" src="media/saveOffset.png" alt="Alt text" width="500"/><br/>
<img style="padding-bottom: 10px;" src="media/Calculated.png" alt="Alt text" width="500"/><br/>

## Integration with Mainsail

AxisScope integrates directly with Mainsail:

- Appears in update manager

## License

[Placeholder: License information]

## Credits

[Placeholder: Acknowledgments and credits]
