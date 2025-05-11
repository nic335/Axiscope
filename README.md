# Axiscope

## What is Axiscope?

Axiscope is a specialized tool designed to simplify the XY calibration process for multi-tool 3D printers using camera-assisted alignment. It provides a streamlined interface for:

- Manual XY calibration using camera feedback
- Quick and precise T0 - Tn alignment
- No calculation required, It just does its magic and tell you the offset.

<br/>
<img src="media/axiscope.png" alt="Alt text" width="500"/><br/>

## Hardware Requirements

### 3D Printed Parts

The following parts are required for camera mounting:

- [\[XY Nozzle Alignment Camera\]](https://www.printables.com/model/1099576-xy-nozzle-alignment-camera)
- OV9726 camera module

### Z Calibration Requirements (Optional)

If you want to use automatic Z calibration:
- An endstop switch mounted at a known position
- Configuration added to your printer.cfg (see Configuration section)


## Installation

**Requirements:**

- Klipper installed and running
- Moonraker configured
- camera setup and running in crownest
- SSH access to your printer



Quick installation using curl:

```bash
curl -sSL https://raw.githubusercontent.com/nic335/Axiscope/refs/heads/main/install.sh | bash
```

The install script will:

- Create Python virtual environment
- Install required dependencies
- Set up the systemd service
- Configure Moonraker integration

### Starting Axiscope

1. Open your Mainsail interface
2. Go to the Machine tab
3. Find 'axiscope' in the services list
4. Use the Start/Stop button to control the service

<img style="padding-bottom: 10px;" src="media/ServiceControl.png" alt="Alt text" width="250"/><br/>

## Configuration

If you want to use automatic Z calibration, add the following to your `printer.cfg`:

```ini
[axiscope]
pin: !PG11                # Endstop pin
zswitch_x_pos: 226.71     # REQUIRED - X position of the endstop switch
zswitch_y_pos: -18.46     # REQUIRED - Y position of the endstop switch
zswitch_z_pos: 7.8        # REQUIRED - Z position of the endstop switch
lift_z: 1                 # OPTIONAL - Amount to lift Z before moving (default: 1)
move_speed: 60            # OPTIONAL - XY movement speed in mm/s (default: 60)
z_move_speed: 10          # OPTIONAL - Z movement speed in mm/s (default: 10)
```
If you plan on using hostname to connect to your printer, For example voron.local:3000, you will need to add the following to your moonraker.conf: `*.local:*`
this should look like this

```ini
[authorization]
trusted_clients:
    192.168.0.0/16
    10.0.0.0/8
    127.0.0.0/8
    169.254.0.0/16
    172.16.0.0/12
    192.168.0.0/16
    FE80::/10
    ::1/128
cors_domains:
    *.lan
    *.local
    *.local:*
    *://localhost
    *://localhost:*
    *://my.mainsail.xyz
    *://app.fluidd.xyz
```


## Usage Guide

### Initial Setup

1. Access the web interface at `http://your-printer-ip:3000`
2. Select the printer address you are trying to calibrate, ( will most likely be autofiled soon )
3. Select the camera to use
   1. Align `T0` perfectly center to the crosair
   2. Capture Position
   3. Change to `Tn`
      1. Re-Align to center and press X and Y in the side navigator 
      2. From there your new calculated offset should be 

<img style="padding-bottom: 10px;" src="media/T0-Aligment.gif" alt="Alt text" width="500"/><br/>
<img style="padding-bottom: 10px;" src="media/CapturePosChangeT1.gif" alt="Alt text" width="500"/><br/>
<img style="padding-bottom: 10px;" src="media/GrabOffset.gif" alt="Alt text" width="500"/><br/>

## Credits
[Nic335](https://github.com/nic335) and [N3MI-DG](https://github.com/N3MI-DG)

## License
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
