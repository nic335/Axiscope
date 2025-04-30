// AxisScope Main JavaScript
// Configuration and Constants
const CONFIG = {
    DEFAULT_WEBCAM_PATH: '/webcam?action=stream',
    UPDATE_INTERVAL_MS: 1000,
    ENDPOINTS: {
        SERVER_INFO: '/server/info',
        WEBCAMS_LIST: '/server/webcams/list',
        PRINTER_STATUS: '/printer/objects/query?gcode_move&toolhead&toolchanger&quad_gantry_level&stepper_enable',
        TOOLCHANGER_STATUS: '/printer/objects/query?toolchanger',
        GCODE_SCRIPT: '/printer/gcode/script?script='
    },
    GCODE: {
        HOME_ALL: 'G28',
        QGL: 'QUAD_GANTRY_LEVEL',
        DISABLE_MOTORS: 'M84'
    },
    BOUNCE_COMMANDS: [
        'SAVE_GCODE_STATE NAME=bounce_move',
        'G91',
        '-bounce-',
        'RESTORE_GCODE_STATE NAME=bounce_move'
    ]
};

// State Management
class PrinterState {
    constructor() {
        this.printerIp = '';
        this.webcamPath = CONFIG.DEFAULT_WEBCAM_PATH;
        this.updateInterval = null;
    }

    getUrl(endpoint) {
        return `http://${this.printerIp}${endpoint}`;
    }

    setIp(ip) {
        this.printerIp = ip;
    }

    setWebcamPath(path) {
        this.webcamPath = path;
    }

    clearState() {
        this.printerIp = '';
        this.webcamPath = CONFIG.DEFAULT_WEBCAM_PATH;
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }
}

// Utility Functions
class Utils {
    static isValidIP(ip) {
        console.log('Validating IP:', ip);
        // Allow IP with optional port number
        const ipRegex = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/;
        if (!ipRegex.test(ip)) {
            console.log('IP failed regex test');
            return false;
        }
        
        // Extract just the IP part without port
        const ipPart = ip.split(':')[0];
        console.log('IP part without port:', ipPart);
        
        const isValid = ipPart.split('.').every(part => {
            const num = parseInt(part, 10);
            const valid = num >= 0 && num <= 255;
            if (!valid) console.log('Invalid octet:', part);
            return valid;
        });
        
        console.log('IP validation result:', isValid);
        return isValid;
    }

    static replaceClass(id, oldClass, newClass) {
        const element = $(id);
        if (element.hasClass(oldClass)) {
            element.removeClass(oldClass).addClass(newClass);
        }
    }

    static generateBounceCommands(axis, value) {
        // Calculate overshoot and return values
        const overshoot = value > 0 ? value + 0.5 : value - 0.5;
        const returnMove = value > 0 ? -0.5 : 0.5;
        
        console.log(`Bounce move for ${axis}${value}:`);
        console.log(`- Overshoot: ${axis}${overshoot}`);
        console.log(`- Return: ${axis}${returnMove}`);
        
        const commands = [
            'SAVE_GCODE_STATE NAME=bounce_move',
            'G91',  // Relative positioning
            `G0 ${axis}${overshoot} F500`,  // Fast move with overshoot
            `G0 ${axis}${returnMove} F500`,  // Return move to exact position
            'RESTORE_GCODE_STATE NAME=bounce_move'
        ];
        
        const finalCommand = commands.join('%0A');
        console.log('Final G-code:', finalCommand);
        
        return finalCommand;
    }
}

// UI Update Manager
class UIManager {
    static updatePositions(gcodePos) {
        ['x', 'y', 'z'].forEach((axis, i) => {
            const value = gcodePos[i].toFixed(3);
            const element = $(`#pos-${axis}`);
            if (element.text() !== value) {
                element.text(value);
            }
        });
    }

    static updateHoming(homed) {
        $("#home-all").data("homed", homed);
        const [fromClass, toClass] = homed ? ["btn-danger", "btn-primary"] : ["btn-primary", "btn-danger"];
        
        ["#home-all", "#home-fine-x", "#home-fine-y", "#home-course-x", "#home-course-y", "#home-course-z"]
            .forEach(id => Utils.replaceClass(id, fromClass, toClass));
    }

    static updateQGL(qglDone) {
        $("#qgl").data("qgl", qglDone);
        Utils.replaceClass("#qgl", qglDone ? "btn-danger" : "btn-primary", qglDone ? "btn-primary" : "btn-danger");
    }

    static updateMotor(enabled) {
        $("#disable-motors").data("motoron", enabled);
        Utils.replaceClass("#disable-motors", enabled ? "btn-danger" : "btn-primary", enabled ? "btn-primary" : "btn-danger");
    }

    static updateTools(tools, currentTool) {
        // Update tool buttons based on current tool
        tools.forEach(toolNumber => {
            const $toolBtn = $(`button[data-tool="${toolNumber}"]`);
            if (toolNumber === currentTool) {
                $toolBtn.addClass('btn-primary').removeClass('btn-secondary').prop('disabled', true);
                // Enable capture position for active tool
                $('#capture-pos').prop('disabled', false);
            } else {
                $toolBtn.addClass('btn-secondary').removeClass('btn-primary').prop('disabled', false);
            }
        });
    }

    static showError(message, isSuccess = false) {
        $('#ipError')
            .removeClass(isSuccess ? 'text-danger' : 'text-success')
            .addClass(isSuccess ? 'text-success' : 'text-danger')
            .text(message)
            .show();
    }
}

// Printer Communication
class PrinterAPI {
    constructor(state) {
        this.state = state;
    }

    async getPrinterStatus() {
        try {
            const response = await $.get(this.state.getUrl(CONFIG.ENDPOINTS.PRINTER_STATUS));
            if (response.result) {
                const status = response.result.status;
                return {
                    positions: status.gcode_move.position,
                    gcodePos: status.gcode_move.gcode_position,
                    homed: status.toolhead.homed_axes === "xyz",
                    qglDone: status.quad_gantry_level.applied,
                    steppers: status.stepper_enable.steppers,
                    toolNumber: status.toolchanger.tool_number,
                    tools: status.toolchanger.tool_numbers
                };
            }
        } catch (error) {
            console.error('Failed to get printer status:', error);
            throw error;
        }
    }

    async getServerInfo() {
        try {
            const response = await $.get(this.state.getUrl(CONFIG.ENDPOINTS.SERVER_INFO));
            return response.result?.klippy_connected || false;
        } catch (error) {
            console.error('Failed to get server info:', error);
            throw error;
        }
    }

    async getWebcams() {
        try {
            const response = await $.get(this.state.getUrl(CONFIG.ENDPOINTS.WEBCAMS_LIST));
            return response.result?.webcams || [];
        } catch (error) {
            console.error('Failed to get webcams:', error);
            throw error;
        }
    }

    async getToolchangerStatus() {
        try {
            const response = await $.get(this.state.getUrl(CONFIG.ENDPOINTS.TOOLCHANGER_STATUS));
            return {
                toolNames: response.result.status.toolchanger.tool_names,
                toolNumbers: response.result.status.toolchanger.tool_numbers,
                activeTool: response.result.status.toolchanger.tool_number
            };
        } catch (error) {
            console.error('Failed to get toolchanger status:', error);
            throw error;
        }
    }

    async getToolOffsets(toolNames) {
        try {
            const queryString = toolNames.join('&');
            const response = await $.get(this.state.getUrl(`/printer/objects/query?${queryString}`));
            return toolNames.map(name => ({
                toolNumber: response.result.status[name].tool_number,
                xOffset: response.result.status[name].gcode_x_offset.toFixed(3),
                yOffset: response.result.status[name].gcode_y_offset.toFixed(3)
            }));
        } catch (error) {
            console.error('Failed to get tool offsets:', error);
            throw error;
        }
    }

    async changeTool(toolNumber, position = null) {
        try {
            let command = `T${toolNumber}`;
            
            if (position) {
                command += '%0ASAVE_GCODE_STATE NAME=RESTORE_POS';
                command += '%0AG90';
                command += `%0AG0 Z${position.z} F3000`;
                command += `%0AG0 X${position.x} Y${position.y} F12000`;
                command += '%0ARESTORE_GCODE_STATE NAME=RESTORE_POS';
            }
            
            await $.get(this.state.getUrl(CONFIG.ENDPOINTS.GCODE_SCRIPT + command));
            return true;
        } catch (error) {
            console.error('Tool change failed:', error);
            throw error;
        }
    }
}

// Main Application
class AxisScope {
    constructor() {
        this.state = new PrinterState();
        this.api = new PrinterAPI(this.state);
        this.initializeEventListeners();
        $('#printerModal').modal('show');
    }

    initializeEventListeners() {
        // Printer Modal Events
        $('#ChangePrinter').on('click', () => $('#printerModal').modal('show'));
        $('#printerIp').on('input', this.handleIpInput.bind(this));
        $('#saveIpBtn').on('click', this.handleIpSave.bind(this));
        $('#disconnectBtn').on('click', this.handleDisconnect.bind(this));
        $(document).on('click', '.camera-option', this.handleCameraSelection.bind(this));
        $(document).on('click', 'button[data-url]', this.handleButtonClick.bind(this));
        
        // Tool-related event listeners
        $(document).on('click', '#capture-pos', this.handleCapturePosition.bind(this));
        $(document).on('click', 'button[id^="toolchange"]', this.handleToolChange.bind(this));
        $(document).on('click', 'button[id^="T"][id$="-fetch-x"], button[id^="T"][id$="-fetch-y"]', this.handleFetchOffset.bind(this));
        $(document).on('input', 'input[name^="T"][name$="-x-pos"], input[name^="T"][name$="-y-pos"]', this.handleOffsetInput.bind(this));
    }

    async loadTools() {
        try {
            const { toolNames, toolNumbers, activeTool } = await this.api.getToolchangerStatus();
            const toolOffsets = await this.api.getToolOffsets(toolNames);
            
            $('#tool-list').empty();
            
            toolOffsets.forEach(({ toolNumber, xOffset, yOffset }) => {
                const disabled = toolNumber === activeTool ? '' : 'disabled';
                const tcDisabled = toolNumber === activeTool ? 'disabled' : '';
                
                const listItem = toolNumber === 0
                    ? this.renderZeroTool(toolNumber, disabled, tcDisabled)
                    : this.renderNonZeroTool(toolNumber, xOffset, yOffset, disabled, tcDisabled);
                
                $('#tool-list').append(listItem);
            });
            
            UIManager.updateTools(toolNumbers, activeTool);
        } catch (error) {
            console.error('Failed to load tools:', error);
            UIManager.showError('Failed to load tools');
        }
    }

    renderZeroTool(toolNumber, disabled, tcDisabled) {
        return `
            <li class="list-group-item bg-body-tertiary p-2">
                <div class="container">
                    <div class="row">
                        <div class="col-2">
                            <button type="button" class="btn btn-secondary btn-sm w-100 h-100 ${tcDisabled}"
                                    id="toolchange" name="T${toolNumber}" data-tool="${toolNumber}">
                                <h1>T${toolNumber}</h1>
                            </button>
                        </div>
                        <div class="col-6">
                            <button type="button" class="btn btn-sm btn-secondary fs-6 border text-center h-100 w-100 ps-5 pe-5 ${disabled}"
                                    style="padding-bottom:5px; padding-top:5px;" id="capture-pos">
                                CAPTURE<br/>CURRENT<br/>POSITION
                            </button>
                        </div>
                        <div class="col-4 border rounded bg-dark">
                            <div class="row">
                                <span class="fs-6 lh-sm pt-1 pb-1"><small>Captured Position</small></span>
                                <div class="row justify-content-center">
                                    <div class="col-1 ms-4"><span class="fs-5 lh-sm"><small>X:</small></span></div>
                                    <div class="col-6"><span class="fs-5 lh-sm" id="captured-x" data-axis="x"><small></small></span></div>
                                </div>
                                <div class="row justify-content-center">
                                    <div class="col-1 ms-4"><span class="fs-5 lh-sm"><small>Y:</small></span></div>
                                    <div class="col-6"><span class="fs-5 lh-sm" id="captured-y" data-axis="y"><small></small></span></div>
                                </div>
                                <div class="row justify-content-center">
                                    <div class="col-1 ms-4"><span class="fs-5 lh-sm"><small>Z:</small></span></div>
                                    <div class="col-6"><span class="fs-5 lh-sm" id="captured-z" data-axis="z"><small></small></span></div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </li>`;
    }

    renderNonZeroTool(toolNumber, xOffset, yOffset, disabled, tcDisabled) {
        return `
            <li class="list-group-item bg-body-tertiary p-2">
                <div class="container">
                    <div class="row">
                        <div class="col-2">
                            <button type="button" class="btn btn-secondary btn-sm w-100 h-100 ${tcDisabled}"
                                    id="toolchange" name="T${toolNumber}" data-tool="${toolNumber}">
                                <h1>T${toolNumber}</h1>
                            </button>
                        </div>
                        <div class="col-6">
                            <div class="row pb-4">
                                <div class="input-group ps-1 pe-1">
                                    <button class="btn btn-secondary ${disabled}" type="button"
                                            id="T${toolNumber}-fetch-x" data-axis="x" data-tool="${toolNumber}">X</button>
                                    <input type="number" name="T${toolNumber}-x-pos" class="form-control"
                                           placeholder="0.0" aria-label="X Position" data-axis="x"
                                           data-tool="${toolNumber}" ${disabled}>
                                </div>
                            </div>
                            <div class="row">
                                <div class="input-group ps-1 pe-1">
                                    <button class="btn btn-secondary ${disabled}" type="button"
                                            id="T${toolNumber}-fetch-y" data-axis="y" data-tool="${toolNumber}">Y</button>
                                    <input type="number" name="T${toolNumber}-y-pos" class="form-control"
                                           placeholder="0.0" aria-label="Y Position" data-axis="y"
                                           data-tool="${toolNumber}" ${disabled}>
                                </div>
                            </div>
                        </div>
                        <div class="col-4">
                            <div class="row">
                                <div class="col-12 border rounded bg-dark">
                                    <div class="row justify-content-center">
                                        <div class="col-1"><span class="fs-5 lh-sm">X:</span></div>
                                        <div class="col-6">
                                            <span class="fs-5 lh-sm" id="T${toolNumber}-x-offset">${xOffset}</span>
                                        </div>
                                    </div>
                                    <div class="row justify-content-center">
                                        <div class="col-1"><span class="fs-5 lh-sm">Y:</span></div>
                                        <div class="col-6">
                                            <span class="fs-5 lh-sm" id="T${toolNumber}-y-offset">${yOffset}</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <div class="row pt-2">
                                <div class="col-12 border rounded bg-dark">
                                    <div class="row justify-content-center">
                                        <div class="col-1"><span class="fs-5 lh-sm">X:</span></div>
                                        <div class="col-6">
                                            <span class="fs-5 lh-sm" id="T${toolNumber}-x-new"><small>0.000</small></span>
                                        </div>
                                    </div>
                                    <div class="row justify-content-center">
                                        <div class="col-1"><span class="fs-5 lh-sm">Y:</span></div>
                                        <div class="col-6">
                                            <span class="fs-5 lh-sm" id="T${toolNumber}-y-new"><small>0.000</small></span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </li>`;
    }

    async handleCapturePosition() {
        const status = await this.api.getPrinterStatus();
        const { gcodePos } = status;
        
        ['x', 'y', 'z'].forEach((axis, i) => {
            $(`#captured-${axis}`).html(`<small>${gcodePos[i].toFixed(3)}</small>`);
        });
    }

    async handleToolChange(event) {
        const toolNumber = $(event.currentTarget).data('tool');
        const position = {
            x: $('#captured-x').text() || null,
            y: $('#captured-y').text() || null,
            z: $('#captured-z').text() || null
        };
        
        try {
            await this.api.changeTool(toolNumber, position.x ? position : null);
            await this.loadTools();
        } catch (error) {
            UIManager.showError('Tool change failed');
        }
    }

    async handleFetchOffset(event) {
        const $button = $(event.currentTarget);
        const axis = $button.data('axis');
        const toolNumber = $button.data('tool');
        const status = await this.api.getPrinterStatus();
        
        $(`input[name=T${toolNumber}-${axis}-pos]`).val(status.gcodePos[axis === 'x' ? 0 : 1].toFixed(3));
        this.updateOffset(toolNumber, axis);
    }

    handleOffsetInput(event) {
        const $input = $(event.currentTarget);
        const toolNumber = $input.data('tool');
        const axis = $input.data('axis');
        this.updateOffset(toolNumber, axis);
    }

    updateOffset(tool, axis) {
        const capturedPos = $(`#captured-${axis}`).text();
        if (!capturedPos) return;
        
        const position = parseFloat($(`input[name=T${tool}-${axis}-pos]`).val()) || 0;
        const oldOffset = parseFloat($(`#T${tool}-${axis}-offset`).text());
        let newOffset = (parseFloat(capturedPos) - oldOffset) - position;
        newOffset = newOffset < 0 ? Math.abs(newOffset) : -newOffset;
        
        const newOffsetText = newOffset.toFixed(3);
        const gcodeCommand = `gcode_${axis}_offset: ${newOffsetText}`;
        
        $(`#T${tool}-${axis}-new`).find('>:first-child').text(newOffsetText);
        $(`#T${tool}-${axis}-gcode`).attr('value', gcodeCommand);
    }

    async handleIpInput(event) {
        const ip = event.target.value;
        const isValid = Utils.isValidIP(ip);
        $('#ipError').toggle(!isValid);
        $('#saveIpBtn').prop('disabled', !isValid);
    }

    async handleIpSave() {
        const ip = $('#printerIp').val();
        if (!Utils.isValidIP(ip)) return;

        const $btn = $('#saveIpBtn');
        $btn.prop('disabled', true)
            .html('<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Connecting...');

        try {
            // Set the IP first
            this.state.setIp(ip);
            
            // Then try to connect
            const isConnected = await this.api.getServerInfo();
            if (!isConnected) {
                this.state.setIp(''); // Reset IP if connection fails
                throw new Error('Printer is not ready');
            }

            // Update UI for camera selection
            $('#printerIp').prop('disabled', true);
            $('#disconnectBtn').show();
            
            // Load cameras and wait for selection
            await this.loadCameras();
            
            // Show camera selection section
            $('#camera-select').show();
            $('#saveIpBtn')
                .html('Select Camera')
                .prop('disabled', false)
                .removeClass('btn-primary')
                .addClass('btn-success');
            
            UIManager.showError('Connected successfully! Please select a camera.', true);
        } catch (error) {
            UIManager.showError(error.message);
            $btn.prop('disabled', false).text('Retry Connection');
        }
    }

    async loadCameras() {
        try {
            const cameras = await this.api.getWebcams();
            if (cameras.length === 0) {
                throw new Error('No cameras found on this printer');
            }

            const $cameraList = $('#cameraList').empty();
            cameras.forEach(cam => {
                const streamUrl = this.state.getUrl(cam.stream_url);
                const snapshotUrl = streamUrl.replace('?action=stream', '?action=snapshot');
                
                const cameraOption = `
                    <div class="camera-option p-2" data-url="${streamUrl}">
                        <div class="d-flex align-items-center">
                            <div class="me-3">
                                <img src="${snapshotUrl}" class="camera-preview" alt="${cam.name}">
                            </div>
                            <div>
                                <h6 class="mb-0">${cam.name}</h6>
                                <small class="text-muted">Click to select</small>
                            </div>
                        </div>
                    </div>`;
                
                $cameraList.append(cameraOption);
            });
        } catch (error) {
            UIManager.showError(error.message);
        }
    }

    async handleCameraSelection(event) {
        event.preventDefault();
        const selectedUrl = $(event.currentTarget).data('url');
        if (!selectedUrl) return;

        $('.camera-option').removeClass('selected');
        $(event.currentTarget).addClass('selected');
        
        try {
            await this.connectCamera(selectedUrl);
            $('#printerModal').modal('hide');
            await this.startUpdateCycle();
            await this.initializePositionBars();
            await this.loadTools();
        } catch (error) {
            UIManager.showError('Failed to connect to camera');
        }
    }

    async connectCamera(selectedUrl) {
        const selectedIp = $('#printerIp').val();
        console.log('Selected URL:', selectedUrl);
        
        // Parse the URL to get just the path portion
        const webcamPath = selectedUrl.split(selectedIp)[1] || '/webcam?action=stream';
        console.log('Webcam path:', webcamPath);
        
        this.state.setWebcamPath(webcamPath);
        
        // Update camera stream
        const cameraUrl = this.state.getUrl(webcamPath);
        console.log('Camera URL:', cameraUrl);
        $('#camera-stream').attr('src', cameraUrl);
        
        // Update UI
        $("#zoom-image").attr("src", cameraUrl);
        
        // Initialize buttons
        this.initializeButtons();
        
        // Show camera and close modal
        $('#camContainer').fadeIn();
        $('#printerModal').modal('hide');
        
        // Initialize position UI
        $('#BouncePositionBar, #BigPositionBar').empty();
        this.initializePositionBars();
        
        // Start updates
        this.startUpdateCycle();
    }

    handleDisconnect() {
        this.state.clearState();
        
        // Reset UI
        $('#printerIp').prop('disabled', false);
        $('#disconnectBtn').hide();
        $('#camera-select').hide();
        $('#camContainer').hide();
        $('#saveIpBtn')
            .html('Save IP')
            .prop('disabled', false)
            .removeClass('btn-success btn-primary')
            .addClass('btn-primary');
        $('#ipError').hide();
        $('#cameraList').empty();
        $('#BouncePositionBar, #BigPositionBar').empty();
    }

    initializeButtons() {
        const buttons = {
            "#home-all": CONFIG.GCODE.HOME_ALL,
            "#qgl": CONFIG.GCODE.QGL,
            "#disable-motors": CONFIG.GCODE.DISABLE_MOTORS
        };

        Object.entries(buttons).forEach(([selector, gcode]) => {
            $(selector)
                .attr("data-url", this.state.getUrl(CONFIG.ENDPOINTS.GCODE_SCRIPT + gcode))
                .attr("data-homed", "false")
                .addClass("btn-danger")
                .removeClass("btn-primary");
        });
    }

    async handleButtonClick(event) {
        const $button = $(event.currentTarget);
        const url = $button.data("url");
        if (!url) return;

        try {
            await $.get(url);
        } catch (error) {
            console.error('Button action failed:', error);
            UIManager.showError('Button action failed');
        }
    }

    async startUpdateCycle() {
        if (this.state.updateInterval) {
            clearInterval(this.state.updateInterval);
        }

        this.state.updateInterval = setInterval(() => this.updateStatus(), CONFIG.UPDATE_INTERVAL_MS);
        await this.updateStatus();
        await this.loadTools();
    }

    async updateStatus() {
        try {
            const status = await this.api.getPrinterStatus();
            UIManager.updatePositions(status.gcodePos);
            UIManager.updateHoming(status.homed);
            UIManager.updateQGL(status.qglDone);
            UIManager.updateMotor(Object.values(status.steppers).some(Boolean));
            UIManager.updateTools(status.tools, status.toolNumber);
        } catch (error) {
            console.error('Status update failed:', error);
        }
    }

    initializePositionBars() {
        const bounceMove = (axis, value) => this.state.getUrl(`/printer/gcode/script?script=${Utils.generateBounceCommands(axis, value)}`);
        
        // Clear both position bar containers
        $('#BouncePositionBar, #BigPositionBar').empty();
        
        // Initialize fine movement controls
        const $container = $("#BouncePositionBar");
        const axes = ["X", "Y"];
        
        axes.forEach(axis => {
            const $row = $('<div class="row pb-1"></div>');
            const $toolbar = $('<div class="btn-toolbar justify-content-center" role="toolbar" aria-label="Movement Toolbar"></div>');
            const $btnGroup = $('<div class="btn-group btn-group-sm ps-5 pe-5" role="group"></div>');

            [-0.01, -0.05, -0.1, -0.5].forEach(value => {
                $('<button>', {
                    type: "button",
                    class: "btn btn-secondary border",
                    "data-url": bounceMove(axis, value),
                    text: value.toFixed(2)
                }).appendTo($btnGroup);
            });

            $('<button>', {
                type: "button",
                class: "btn btn-dark border border-dark",
                "data-url": this.state.getUrl(`/printer/gcode/script?script=G28${axis}`),
                id: `home-fine-${axis.toLowerCase()}`,
                text: axis
            }).appendTo($btnGroup);

            [0.5, 0.1, 0.05, 0.01].forEach(value => {
                $('<button>', {
                    type: "button",
                    class: "btn btn-secondary border",
                    "data-url": bounceMove(axis, value),
                    text: `+${value.toFixed(2)}`
                }).appendTo($btnGroup);
            });

            $toolbar.append($btnGroup);
            $row.append($toolbar);
            $container.append($row);
        });

        // Initialize coarse movement controls
        const $containerBigPos = $("#BigPositionBar");
        const axesBigPos = ["X", "Y", "Z"];
        
        axesBigPos.forEach(axis => {
            const $row = $('<div class="row pb-1"></div>');
            const $toolbar = $('<div class="btn-toolbar justify-content-center" role="toolbar" aria-label="Movement Toolbar"></div>');
            const $btnGroup = $('<div class="btn-group btn-group-sm ps-5 pe-5" role="group"></div>');

            const values = axis !== "Z" ? [-50, -10, -5, -1] : [-25, -10, -1, -.1];
            values.forEach(value => {
                $('<button>', {
                    type: "button",
                    class: "btn btn-secondary border",
                    "data-url": bounceMove(axis, value),
                    text: value.toFixed(2)
                }).appendTo($btnGroup);
            });

            $('<button>', {
                type: "button",
                class: "btn btn-dark border border-dark",
                "data-url": this.state.getUrl(`/printer/gcode/script?script=G28${axis}`),
                id: `home-course-${axis.toLowerCase()}`,
                text: axis
            }).appendTo($btnGroup);

            const reverseValues = axis !== "Z" ? [50, 10, 5, 1].reverse() : [25, 10, 1, .1].reverse();
            reverseValues.forEach(value => {
                $('<button>', {
                    type: "button",
                    class: "btn btn-secondary border",
                    "data-url": bounceMove(axis, value),
                    text: `+${value.toFixed(2)}`
                }).appendTo($btnGroup);
            });

            $toolbar.append($btnGroup);
            $row.append($toolbar);
            $containerBigPos.append($row);
        });
    }
}

// Initialize application when document is ready
$(document).ready(() => {
    window.axiscope = new AxisScope();
});
