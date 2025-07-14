
from . import tools_calibrate
from . import toolchanger

class Axiscope:
    def __init__(self, config):
        self.printer       = config.get_printer()
        self.gcode         = self.printer.lookup_object('gcode')
    
        self.x_pos         = config.getfloat('zswitch_x_pos', None)
        self.y_pos         = config.getfloat('zswitch_y_pos', None)
        self.z_pos         = config.getfloat('zswitch_z_pos', None)
        self.lift_z        = config.getfloat('lift_z'       , 1)
        self.move_speed    = config.getint('move_speed'  , 60)
        self.z_move_speed  = config.getint('z_move_speed', 10)
        self.samples       = config.getint('samples'     , 10)
        
        # Load gcode_macro module for template support
        self.gcode_macro = self.printer.load_object(config, 'gcode_macro')
        
        # Custom gcode macros
        self.start_gcode = self.gcode_macro.load_template(config, 'start_gcode', '')
        self.before_pickup_gcode = self.gcode_macro.load_template(config, 'before_pickup_gcode', '')
        self.after_pickup_gcode = self.gcode_macro.load_template(config, 'after_pickup_gcode', '')
        self.finish_gcode = self.gcode_macro.load_template(config, 'finish_gcode', '')

        self.probe_results = {}

        self.probe_multi_axis = tools_calibrate.PrinterProbeMultiAxis(
            config, 
            tools_calibrate.ProbeEndstopWrapper(config, 'x'),
            tools_calibrate.ProbeEndstopWrapper(config, 'y'),
            tools_calibrate.ProbeEndstopWrapper(config, 'z')
        )

        self.toolchanger = self.printer.load_object(config, 'toolchanger')
        query_endstops = self.printer.load_object(config, 'query_endstops')
        query_endstops.register_endstop(self.probe_multi_axis.mcu_probe[-1].mcu_endstop, "Axiscope")

        self.gcode.register_command('MOVE_TO_ZSWITCH', self.cmd_MOVE_TO_ZSWITCH, desc=self.cmd_MOVE_TO_ZSWITCH_help)
        self.gcode.register_command('PROBE_ZSWITCH',   self.cmd_PROBE_ZSWITCH, desc=self.cmd_PROBE_ZSWITCH_help)
        self.gcode.register_command('CALIBRATE_ALL_Z_OFFSETS',   self.cmd_CALIBRATE_ALL_Z_OFFSETS, desc=self.cmd_CALIBRATE_ALL_Z_OFFSETS_help)

        self.gcode.register_command('AXISCOPE_START_GCODE', self.cmd_AXISCOPE_START_GCODE, desc="Execute the Axiscope start G-code macro")
        self.gcode.register_command('AXISCOPE_BEFORE_PICKUP_GCODE', self.cmd_AXISCOPE_BEFORE_PICKUP_GCODE, desc="Execute the Axiscope before pickup G-code macro")
        self.gcode.register_command('AXISCOPE_AFTER_PICKUP_GCODE', self.cmd_AXISCOPE_AFTER_PICKUP_GCODE, desc="Execute the Axiscope after pickup G-code macro")
        self.gcode.register_command('AXISCOPE_FINISH_GCODE', self.cmd_AXISCOPE_FINISH_GCODE, desc="Execute the Axiscope finish G-code macro")


    def get_status(self, eventtime):
        return {
            'probe_results': self.probe_results,
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
        toolhead.manual_move([self.x_pos, self.y_pos, current_pos[2]], self.move_speed)
        
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

def load_config(config):
    return Axiscope(config)