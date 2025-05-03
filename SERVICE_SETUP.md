# Setting up AxisScope as a Moonraker-managed service

1. Copy the service file to systemd:
```bash
sudo cp axiscope.service /etc/systemd/system/
```

2. Add AxisScope to Moonraker's allowed services:
```bash
echo "axiscope" >> ~/printer_data/moonraker.asvc
```

3. Reload systemd and start the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable axiscope
sudo systemctl start axiscope
```

4. Add the following to your `moonraker.conf`:
```ini
[update_manager axiscope]
type: git_repo
path: ~/axiscope
origin: https://github.com/N3MI-DG/Axiscope.git
primary_branch: main
is_system_service: True
