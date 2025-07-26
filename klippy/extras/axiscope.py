
import os
import ast
from . import tools_calibrate
from . import toolchanger

class Axiscope:
    def __init__(self, config):
        self.printer       = config.get_printer()
        self.gcode         = self.printer.lookup_object('gcode')
        self.gcode_move = self.printer.load_object(config, 'gcode_move')

        self.x_pos         = config.getfloat('zswitch_x_pos', None)
        self.y_pos         = config.getfloat('zswitch_y_pos', None)
        self.z_pos         = config.getfloat('zswitch_z_pos', None)
        self.lift_z        = config.getfloat('lift_z'       , 1)
        self.move_speed    = config.getint('move_speed'  , 60)
        self.z_move_speed  = config.getint('z_move_speed', 10)
        self.samples       = config.getint('samples'     , 10)

        self.pin              = config.get('pin'             , None)
        self.config_file_path = config.get('config_file_path', None)
        
        # Load gcode_macro module for template support
        self.gcode_macro = self.printer.load_object(config, 'gcode_macro')
        
        # Custom gcode macros
        self.start_gcode = self.gcode_macro.load_template(config, 'start_gcode', '')
        self.before_pickup_gcode = self.gcode_macro.load_template(config, 'before_pickup_gcode', '')
        self.after_pickup_gcode = self.gcode_macro.load_template(config, 'after_pickup_gcode', '')
        self.finish_gcode = self.gcode_macro.load_template(config, 'finish_gcode', '')

        self.has_cfg_data     = False
        self.probe_results = {}

        #setup endstop in query_endstops if pin is set
        if self.pin is not None:
            self.probe_multi_axis = tools_calibrate.PrinterProbeMultiAxis(
                config, 
                tools_calibrate.ProbeEndstopWrapper(config, 'x'),
                tools_calibrate.ProbeEndstopWrapper(config, 'y'),
                tools_calibrate.ProbeEndstopWrapper(config, 'z')
            )
            query_endstops = self.printer.load_object(config, 'query_endstops')
            query_endstops.register_endstop(self.probe_multi_axis.mcu_probe[-1].mcu_endstop, "Axiscope")
        else:
            self.probe_multi_axis = None

        self.toolchanger = self.printer.load_object(config, 'toolchanger')

        self.printer.register_event_handler("klippy:connect", self.handle_connect)

        #register gcode commands
        self.gcode.register_command('MOVE_TO_ZSWITCH', self.cmd_MOVE_TO_ZSWITCH, desc=self.cmd_MOVE_TO_ZSWITCH_help)
        self.gcode.register_command('PROBE_ZSWITCH',   self.cmd_PROBE_ZSWITCH, desc=self.cmd_PROBE_ZSWITCH_help)
        self.gcode.register_command('CALIBRATE_ALL_Z_OFFSETS',   self.cmd_CALIBRATE_ALL_Z_OFFSETS, desc=self.cmd_CALIBRATE_ALL_Z_OFFSETS_help)

        self.gcode.register_command('AXISCOPE_START_GCODE', self.cmd_AXISCOPE_START_GCODE, desc="Execute the Axiscope start G-code macro")
        self.gcode.register_command('AXISCOPE_BEFORE_PICKUP_GCODE', self.cmd_AXISCOPE_BEFORE_PICKUP_GCODE, desc="Execute the Axiscope before pickup G-code macro")
        self.gcode.register_command('AXISCOPE_AFTER_PICKUP_GCODE', self.cmd_AXISCOPE_AFTER_PICKUP_GCODE, desc="Execute the Axiscope after pickup G-code macro")
        self.gcode.register_command('AXISCOPE_FINISH_GCODE', self.cmd_AXISCOPE_FINISH_GCODE, desc="Execute the Axiscope finish G-code macro")
        self.gcode.register_command('AXISCOPE_SAVE_TOOL_OFFSET',          self.cmd_AXISCOPE_SAVE_TOOL_OFFSET,          desc=self.cmd_AXISCOPE_SAVE_TOOL_OFFSET_help)
        self.gcode.register_command('AXISCOPE_SAVE_MULTIPLE_TOOL_OFFSETS', self.cmd_AXISCOPE_SAVE_MULTIPLE_TOOL_OFFSETS, desc=self.cmd_AXISCOPE_SAVE_MULTIPLE_TOOL_OFFSETS_help)

    def handle_connect(self):
        if self.config_file_path is not None:
            expanded_path = os.path.expanduser(self.config_file_path)
            self.config_file_path = expanded_path
            
            if os.path.exists(self.config_file_path):
                self.has_cfg_data = True
                self.gcode.respond_info("Axiscope config file found (%s)." % self.config_file_path)
                self.gcode.respond_info("--Axiscope Loaded--")
            else:
                self.gcode.respond_info("Could not find Axiscope config file (%s)" % self.config_file_path)
                self.gcode.respond_info("Note: You can use ~ for home directory, e.g., ~/printer_data/config/axiscope.offsets")

        else:
            self.gcode.respond_info("Axiscope is missing config file location (config_file_path). You will need to update your tool offsets manually.")
            self.gcode.respond_info("You can set config_file_path: ~/printer_data/config/axiscope.offsets in your [axiscope] section.")


    def get_status(self, eventtime):
        return {
            'probe_results':   self.probe_results,
            'can_save_config': self.has_cfg_data is not False
        }
        
    def run_gcode(self, name, template, extra_context):
        """Run gcode with template expansion and context"""
        curtime = self.printer.get_reactor().monotonic()
        context = {
            **template.create_template_context(),
            'tool': self.toolchanger.active_tool.get_status(
                curtime) if self.toolchanger.active_tool else {},
            'toolchanger': self.toolchanger.get_status(curtime),
            'axiscope': self.get_status(curtime),
            **extra_context,
        }
        template.run_gcode_from_command(context)


    def is_homed(self):
        toolhead   = self.printer.lookup_object('toolhead')
        ctime      = self.printer.get_reactor().monotonic()
        homed_axes = toolhead.get_kinematics().get_status(ctime)['homed_axes']

        return all(x in homed_axes for x in 'xyz')


    def has_switch_pos(self):
        return all(x is not None for x in [self.x_pos, self.y_pos, self.z_pos])

    def update_tool_offsets(self, cfg_data, tool_name, offsets):
        axis          = "xyz" if len(offsets) == 3 else "xy"
        section_name  = "[%s]" % tool_name
        section_start = None
        section_end   = None
        new_section   = None

        for i, line in enumerate(cfg_data):
            stripped_line = line.lstrip()
            if stripped_line.startswith(section_name):
                section_start = i+1
            
            elif section_start is not None:
                if stripped_line.startswith('['):
                    section_end = i-1
                    break

        for i, a in enumerate(axis):
            offset_name   = "gcode_%s_offset" % a
            offset_value  = offsets[i]
            offset_string = "%s: %.3f\n" % (offset_name, offset_value)

            if section_start is not None:
                if section_end is not None:
                    section_lines = cfg_data[section_start:section_end+1]
                else:
                    section_lines = cfg_data[section_start:]

                for line in section_lines:
                    stripped_line = line.lstrip()

                    if stripped_line.startswith(offset_name):
                        cfg_index = cfg_data.index(line)
                        cfg_data[cfg_index] = offset_string

            else:
                if new_section is not None:
                    new_section.append(offset_string)
                else:
                    new_section = ["\n", section_name+"\n", offset_string]

        if new_section is not None:
            new_section.append("\n")
            no_touch_index = None

            if self.config_file_path.endswith('printer.cfg'):
                for line in cfg_data:
                    if line.lstrip().startswith('#*#'):
                        no_touch_index = cfg_data.index(line)
                        break

            if no_touch_index is not None:
                cfg_data = cfg_data[:no_touch_index] + ["\n"] + new_section + cfg_data[no_touch_index:]

            else:
                cfg_data = cfg_data + ["\n"] + new_section
        
        return cfg_data

    cmd_MOVE_TO_ZSWITCH_help = "Move the toolhead over the Z switch"

    def cmd_MOVE_TO_ZSWITCH(self, gcmd):
        if not self.is_homed():
            gcmd.respond_info('Must home first.')
            return

        if not self.has_switch_pos():
            gcmd.respond_error('Z switch positions are not valid.')
            return

        gcmd.respond_info('Moving to Z Switch')

        toolhead = self.printer.lookup_object('toolhead')
        toolhead.wait_moves()

        # Get current position
        current_pos = toolhead.get_position()

        # First move horizontally to the target X,Y at current Z height
        #toolhead.manual_move([self.x_pos, self.y_pos, current_pos[2]], self.move_speed)
        self.gcode_move.cmd_G1(self.gcode.create_gcode_command("G0", "G0", { 'X': self.x_pos, 'Y': self.y_pos, 'Z': current_pos[2], 'F': self.move_speed*60 }))

        # Then move vertically to the target Z height
        toolhead.manual_move([None, None, self.z_pos+self.lift_z], self.z_move_speed)


    cmd_PROBE_ZSWITCH_help = "Probe the Z switch to determine offset."

    def cmd_PROBE_ZSWITCH(self, gcmd):
        toolhead  = self.printer.lookup_object('toolhead')
        tool_no   = str(self.toolchanger.active_tool.tool_number)
        start_pos = toolhead.get_position()
        z_result  = self.probe_multi_axis.run_probe("z-", gcmd, speed_ratio=0.5, max_distance=10.0, samples=self.samples)[2]
        
        self.reactor = self.printer.get_reactor()
        measured_time = self.reactor.monotonic()

        if tool_no == "0":
            self.probe_results[tool_no] = {'z_trigger': z_result, 'z_offset': 0, 'last_run': measured_time}

        elif "0" in self.probe_results:
            z_offset = z_result - self.probe_results["0"]['z_trigger']

            self.probe_results[tool_no] = {
                'z_trigger': z_result, 
                'z_offset': z_offset,
                'last_run': measured_time
            }

        else:
            self.probe_results[tool_no] = {'z_trigger': z_result, 'z_offset': None, 'last_run': measured_time}


        toolhead.move(start_pos, self.z_move_speed)
        toolhead.set_position(start_pos)
        toolhead.wait_moves()

        return


    cmd_CALIBRATE_ALL_Z_OFFSETS_help = "Probe the Z switch for each tool to determine offset."

    def cmd_CALIBRATE_ALL_Z_OFFSETS(self, gcmd):
        
        if not self.is_homed():
            gcmd.respond_info('Must home first.')
            return
            
        # Run start_gcode at the beginning of calibration
        self.cmd_AXISCOPE_START_GCODE(gcmd)

        for tool_no in self.toolchanger.tool_numbers:
            # Run before_pickup_gcode before tool change
            self.cmd_AXISCOPE_BEFORE_PICKUP_GCODE(gcmd)
            self.gcode.run_script_from_command('T%i' % tool_no)
            # Run after_pickup_gcode after tool change
            self.cmd_AXISCOPE_AFTER_PICKUP_GCODE(gcmd)
            
            self.gcode.run_script_from_command('MOVE_TO_ZSWITCH')
            self.gcode.run_script_from_command('PROBE_ZSWITCH SAMPLES=%i' % self.samples)

        self.gcode.run_script_from_command('T0')

        toolhead = self.printer.lookup_object('toolhead')
        toolhead.wait_moves()

        for tool_no in self.probe_results:
            if tool_no != "0":
                gcmd.respond_info('T%s gcode_z_offset: %.3f' % (tool_no, self.probe_results[tool_no]['z_offset']))
        
        # Run finish_gcode after calibration is complete
        self.cmd_AXISCOPE_FINISH_GCODE(gcmd)
    
    # Command handlers for custom macro G-code commands
    def cmd_AXISCOPE_START_GCODE(self, gcmd):
        """Execute the Axiscope start G-code macro"""
        if self.start_gcode:
            self.run_gcode('start_gcode', self.start_gcode, {})
        else:
            gcmd.respond_info("No start_gcode configured for Axiscope")

    def cmd_AXISCOPE_BEFORE_PICKUP_GCODE(self, gcmd):
        """Execute the Axiscope before pickup G-code macro"""
        if self.before_pickup_gcode:
            self.run_gcode('before_pickup_gcode', self.before_pickup_gcode, {})
        else:
            gcmd.respond_info("No before_pickup_gcode configured for Axiscope")

    def cmd_AXISCOPE_AFTER_PICKUP_GCODE(self, gcmd):
        """Execute the Axiscope after pickup G-code macro"""
        if self.after_pickup_gcode:
            self.run_gcode('after_pickup_gcode', self.after_pickup_gcode, {})
        else:
            gcmd.respond_info("No after_pickup_gcode configured for Axiscope")

    def cmd_AXISCOPE_FINISH_GCODE(self, gcmd):
        """Execute the Axiscope finish G-code macro"""
        if self.finish_gcode:
            self.run_gcode('finish_gcode', self.finish_gcode, {})
        else:
            gcmd.respond_info("No finish_gcode configured for Axiscope")

    cmd_AXISCOPE_SAVE_TOOL_OFFSET_help = "Save a tool offset to your axiscope config file."
    
    def cmd_AXISCOPE_SAVE_TOOL_OFFSET(self, gcmd):
        """
        This function saves the tool offsets for the specified tool.

        Usage
        -----
        `AXISCOPE_SAVE_TOOL_OFFSET TOOL_NAME=<tool_name> OFFSETS=<offsets>`

        Example
        -----
        ```
        AXISCOPE_SAVE_TOOL_OFFSET TOOL_NAME="tool T0" OFFSETS="[-0.01, 0.03, 0.01]"
        ```
        """
        if self.has_cfg_data is not False:
            with open(self.config_file_path, 'r') as f:
                cfg_data = f.readlines()

            tool_name = gcmd.get('TOOL_NAME')
            offsets   = ast.literal_eval(gcmd.get('OFFSETS'))

            out_data = self.update_tool_offsets(cfg_data, tool_name, offsets)
            gcmd.respond_info("Writing %s offsets." % tool_name)

            with open(self.config_file_path, 'w') as f:
                for line in out_data:
                    f.write(line)

                f.close()
                gcmd.respond_info("Offsets written successfully.")

        else:
            gcmd.respond_info("Axiscope needs a valid config location (config_file_path) to save tool offsets.")


    cmd_AXISCOPE_SAVE_MULTIPLE_TOOL_OFFSETS_help = "Save multiple tool offsets to your axiscope config file."

    def cmd_AXISCOPE_SAVE_MULTIPLE_TOOL_OFFSETS(self, gcmd):
        """
        This function saves the offsets for multiple tools'.

        Usage
        -----
        `AXISCOPE_SAVE_MULTIPLE_TOOL_OFFSETS TOOLS=<tools> OFFSETS=<offsets>`

        Example
        -----
        ```
        AXISCOPE_SAVE_MULTIPLE_TOOL_OFFSETS TOOLS="['tool T0', 'tool T1']" OFFSETS="[[-0.01, 0.03, 0.01], [0.02, 0.02, -0.06]]"
        ```
        """
        if self.has_cfg_data is not False:
            with open(self.config_file_path, 'r') as f:
                cfg_data = f.readlines()

            tool_names = gcmd.get('TOOLS')
            offsets    = ast.literal_eval(gcmd.get('OFFSETS'))
            out_data   = cfg_data

            for i, tool_name in enumerate(tool_names):
                out_data = self.update_tool_offsets(cfg_data, tool_name, offsets[i])

            gcmd.respond_info("Writing %s offsets." % tool_name)

            with open(self.config_file_path, 'w') as f:
                for line in out_data:
                    f.write(line)

                f.close()
                gcmd.respond_info("Offsets written successfully.")

        else:
            gcmd.respond_info("Axiscope needs a valid config location (config_file_path) to save tool offsets.")

def load_config(config):
    return Axiscope(config)
