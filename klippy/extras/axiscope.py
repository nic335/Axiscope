
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

        self.probe_results = {}

        self.probe_multi_axis = tools_calibrate.PrinterProbeMultiAxis(
            config, 
            tools_calibrate.ProbeEndstopWrapper(config, 'x'),
            tools_calibrate.ProbeEndstopWrapper(config, 'y'),
            tools_calibrate.ProbeEndstopWrapper(config, 'z')
        )
        
        self.toolchanger = self.printer.load_object(config, 'toolchanger')

        self.gcode.register_command('MOVE_TO_ZSWITCH', self.cmd_MOVE_TO_ZSWITCH, desc=self.cmd_MOVE_TO_ZSWITCH_help)
        self.gcode.register_command('PROBE_ZSWITCH',   self.cmd_PROBE_ZSWITCH, desc=self.cmd_PROBE_ZSWITCH_help)
        self.gcode.register_command('CALIBRATE_ALL_Z_OFFSETS',   self.cmd_CALIBRATE_ALL_Z_OFFSETS, desc=self.cmd_CALIBRATE_ALL_Z_OFFSETS_help)


    def get_status(self, eventtime):
        return {
            'probe_results': self.probe_results,
        }


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

        toolhead.manual_move([None, None, self.z_pos+self.lift_z], self.z_move_speed)
        toolhead.manual_move([self.x_pos, self.y_pos, None], self.move_speed)


    cmd_PROBE_ZSWITCH_help = "Probe the Z switch to determine offset."

    def cmd_PROBE_ZSWITCH(self, gcmd):
        toolhead  = self.printer.lookup_object('toolhead')
        tool_no   = str(self.toolchanger.active_tool.tool_number)
        start_pos = toolhead.get_position()
        z_result  = self.probe_multi_axis.run_probe("z-", gcmd, speed_ratio=0.5, max_distance=10.0, samples=self.samples)[2]

        if tool_no == "0":
            self.probe_results[tool_no] = {'z_trigger': z_result, 'z_offset': 0}

        elif "0" in self.probe_results:
            if z_result > self.probe_results["0"]['z_trigger']:
                z_offset = -(self.probe_results["0"]['z_trigger'] - z_result)
            
            else:
                z_offset = (self.probe_results["0"]['z_trigger'] - z_result)

            self.probe_results[tool_no] = {
                'z_trigger': z_result, 
                'z_offset': z_offset
            }

        else:
            self.probe_results[tool_no] = {'z_trigger': z_result, 'z_offset': None}


        toolhead.move(start_pos, self.z_move_speed)
        toolhead.set_position(start_pos)
        toolhead.wait_moves()

        return


    cmd_CALIBRATE_ALL_Z_OFFSETS_help = "Probe the Z switch for each tool to determine offset."

    def cmd_CALIBRATE_ALL_Z_OFFSETS(self, gcmd):
        if not self.is_homed():
            gcmd.respond_info('Must home first.')
            return

        for tool_no in self.toolchanger.tool_numbers:
            self.gcode.run_script_from_command('T%i' % tool_no)
            self.gcode.run_script_from_command('MOVE_TO_ZSWITCH')
            self.gcode.run_script_from_command('PROBE_ZSWITCH SAMPLES=%i' % self.samples)

        self.gcode.run_script_from_command('T0')

        toolhead = self.printer.lookup_object('toolhead')
        toolhead.wait_moves()

        for tool_no in self.probe_results:
            if tool_no != "0":
                gcmd.respond_info('T%s gcode_z_offset: %.3f' % (tool_no, self.probe_results[tool_no]['z_offset']))
    
def load_config(config):
    return Axiscope(config)