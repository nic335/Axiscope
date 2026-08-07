"""
V4L2 camera control helpers for Axiscope.

Ported (trimmed) from v4l2-ui's v4l2_control.py: parses v4l2-ctl output to
list capture devices and their controls, and applies control changes via
`v4l2-ctl --set-ctrl`. Runs on the same host as the physical camera.
"""

import os
import shutil
import subprocess
import re
import fcntl
import struct
from typing import List, Dict, Tuple, Optional, Any

_V4L2_CTL_CANDIDATES = ['/usr/bin/v4l2-ctl', '/usr/local/bin/v4l2-ctl', '/bin/v4l2-ctl']


def _find_v4l2_ctl() -> str:
    """Locate the v4l2-ctl binary even if PATH is restricted (e.g. by systemd)."""
    found = shutil.which('v4l2-ctl')
    if found:
        return found
    for candidate in _V4L2_CTL_CANDIDATES:
        if os.path.exists(candidate):
            return candidate
    return 'v4l2-ctl'  # fall back, will raise FileNotFoundError if truly missing


V4L2_CTL = _find_v4l2_ctl()


class V4L2Device:
    """Represents a V4L2 video device"""
    def __init__(self, path: str, name: str):
        self.path = path
        self.name = name

    def to_dict(self) -> Dict[str, str]:
        return {'path': self.path, 'name': self.name}


class V4L2Control:
    """Represents a V4L2 control parameter"""
    def __init__(self, name: str, ctrl_type: str, min_val: int = 0, max_val: int = 0,
                 step: int = 1, default: Any = 0, value: Any = 0,
                 menu_options: List[str] = None, inactive: bool = False,
                 menu_indices: List[int] = None, current_menu_idx: int = 0):
        self.name = name
        self.ctrl_type = ctrl_type  # 'int', 'bool', 'menu'
        self.min_val = min_val
        self.max_val = max_val
        self.step = step
        self.default = default
        self.value = value
        self.menu_options = menu_options or []
        self.menu_indices = menu_indices or []  # Actual v4l2 indices for menu items
        self.current_menu_idx = current_menu_idx  # Current v4l2 index value
        self.inactive = inactive

    def to_dict(self) -> Dict[str, Any]:
        return {
            'name': self.name,
            'type': self.ctrl_type,
            'min': self.min_val,
            'max': self.max_val,
            'step': self.step,
            'default': self.default,
            'value': self.value,
            'menu_options': self.menu_options,
            'menu_indices': self.menu_indices,
            'current_menu_idx': self.current_menu_idx,
            'inactive': self.inactive,
        }


_VIDIOC_QUERYCAP = 0x80685600
_VIDIOC_ENUM_FMT = 0xC0405602
_V4L2_CAP_VIDEO_CAPTURE = 0x00000001
_V4L2_CAP_DEVICE_CAPS = 0x80000000
_V4L2_BUF_TYPE_VIDEO_CAPTURE = 1


def _has_video_capture(device_path: str) -> bool:
    """Return True if the node is a usable VIDEO_CAPTURE device."""
    try:
        with open(device_path, 'rb') as f:
            buf = b'\x00' * 104
            r = fcntl.ioctl(f, _VIDIOC_QUERYCAP, buf)
            caps = struct.unpack_from('I', r, 84)[0]
            dc = struct.unpack_from('I', r, 88)[0]
            effective = dc if (caps & _V4L2_CAP_DEVICE_CAPS) else caps
            if not (effective & _V4L2_CAP_VIDEO_CAPTURE):
                return False
            fmt_buf = bytearray(64)
            struct.pack_into('II', fmt_buf, 0, 0, _V4L2_BUF_TYPE_VIDEO_CAPTURE)
            try:
                fcntl.ioctl(f, _VIDIOC_ENUM_FMT, fmt_buf)
                return True
            except OSError:
                return False
    except PermissionError:
        return True  # can't probe -> assume it's a real camera
    except (IOError, OSError):
        return False


def list_devices() -> List[V4L2Device]:
    """Parse v4l2-ctl --list-devices, filtered to VIDEO_CAPTURE nodes only."""
    try:
        result = subprocess.run([V4L2_CTL, '--list-devices'],
                                 capture_output=True, text=True, check=True)
        devices = []
        current_name = None

        for line in result.stdout.split('\n'):
            line = line.strip()
            if not line:
                continue
            if line.startswith('/dev/video'):
                if current_name and _has_video_capture(line):
                    devices.append(V4L2Device(line, current_name))
            elif not line.startswith('/dev/'):
                current_name = line.rstrip(':')

        return devices
    except (subprocess.CalledProcessError, FileNotFoundError):
        return []


def parse_control_line(line: str) -> Optional[V4L2Control]:
    """Parse a single control line from v4l2-ctl --list-ctrls"""
    line = line.strip()
    if not line or line.endswith('Controls'):
        return None

    int_pattern = r'(\w+)\s+0x[0-9a-f]+\s+\(int\)\s+:\s+min=(-?\d+)\s+max=(-?\d+)\s+step=(\d+)\s+default=(-?\d+)\s+value=(-?\d+)'
    bool_pattern = r'(\w+)\s+0x[0-9a-f]+\s+\(bool\)\s+:\s+default=(\d+)\s+value=(\d+)'
    menu_pattern = r'(\w+)\s+0x[0-9a-f]+\s+\(menu\)\s+:\s+min=(\d+)\s+max=(\d+)\s+default=(\d+)\s+value=(\d+)\s+\(([^)]+)\)'

    inactive = 'flags=inactive' in line

    int_match = re.search(int_pattern, line)
    if int_match:
        name, min_v, max_v, step, default, value = int_match.groups()
        return V4L2Control(name, 'int', int(min_v), int(max_v), int(step),
                            int(default), int(value), inactive=inactive)

    bool_match = re.search(bool_pattern, line)
    if bool_match:
        name, default, value = bool_match.groups()
        return V4L2Control(name, 'bool', default=int(default),
                            value=int(value), inactive=inactive)

    menu_match = re.search(menu_pattern, line)
    if menu_match:
        name, min_v, max_v, default, value_idx, current_option = menu_match.groups()
        return V4L2Control(name, 'menu', int(min_v), int(max_v), 1,
                            int(default), current_option, inactive=inactive,
                            current_menu_idx=int(value_idx))

    return None


def list_controls(device_path: str) -> Tuple[List[V4L2Control], Dict[str, List[V4L2Control]]]:
    """Parse v4l2-ctl --list-ctrls output, grouped by category."""
    try:
        result = subprocess.run([V4L2_CTL, '-d', device_path, '--list-ctrls'],
                                 capture_output=True, text=True, check=True)

        controls = []
        grouped = {}
        current_category = 'Controls'

        for line in result.stdout.split('\n'):
            if line.strip().endswith('Controls'):
                current_category = line.strip()
                grouped[current_category] = []
                continue

            ctrl = parse_control_line(line)
            if ctrl:
                controls.append(ctrl)
                if current_category not in grouped:
                    grouped[current_category] = []
                grouped[current_category].append(ctrl)

        # Fill in menu options for menu-type controls
        for ctrl in controls:
            if ctrl.ctrl_type == 'menu':
                indices, options = get_menu_options(device_path, ctrl.name)
                ctrl.menu_indices = indices
                ctrl.menu_options = options

        return controls, grouped
    except (subprocess.CalledProcessError, FileNotFoundError):
        return [], {}


def get_menu_options(device_path: str, control_name: str) -> Tuple[List[int], List[str]]:
    """Get menu options for a menu-type control, returns (indices, option_names)."""
    try:
        result = subprocess.run([V4L2_CTL, '-d', device_path, '--list-ctrls-menus'],
                                 capture_output=True, text=True, check=True)

        in_menu = False
        indices = []
        options = []

        for line in result.stdout.split('\n'):
            if control_name in line and '(menu)' in line:
                in_menu = True
                continue

            if in_menu:
                if line.strip() and line.startswith('\t'):
                    option_match = re.search(r'(\d+):\s+(.+)', line)
                    if option_match:
                        indices.append(int(option_match.group(1)))
                        options.append(option_match.group(2))
                elif line.strip() and not line.startswith('\t'):
                    break

        return indices, options
    except (subprocess.CalledProcessError, FileNotFoundError):
        return [], []


def set_control(device_path: str, control_name: str, value: Any) -> bool:
    """Set a control value."""
    try:
        subprocess.run([V4L2_CTL, '-d', device_path,
                         f'--set-ctrl={control_name}={value}'],
                        capture_output=True, check=True)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False
