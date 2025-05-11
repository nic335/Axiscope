// Global variables and utility functions
let printerIp = '';
let WebcamPath = '/webcam?action=stream';
let path = '/webcam?action=stream';
let updateInterval = null;

function printerUrl(ip, endpoint) {
    ip = ip.replace(/^https?:\/\//, '');
    return `http://${ip}${endpoint}`;
}

function isValidIP(input) {
    input = input.trim();
    if (!input) return false;

    input = input.replace(/^https?:\/\//, '');
    
    const urlRegex = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9](:[0-9]+)?$/;
    return urlRegex.test(input);
}

function updatePage() {
  $.get(printerUrl(printerIp,"/printer/objects/query?gcode_move&toolhead&toolchanger&quad_gantry_level&stepper_enable"), function(data){
    // console.log(printerUrl)
    if (data['result']) {

      var positions   = data['result']['status']['gcode_move']['position'];
      var gcode_pos   = data['result']['status']['gcode_move']['gcode_position'];
      var homed       = data['result']['status']['toolhead']['homed_axes'] == "xyz";
      var qgl_done    = data['result']['status']['quad_gantry_level']['applied'];
      var steppers    = data['result']['status']['stepper_enable']['steppers'];
      // var initialized = data['result']['status']['toolchanger']['status'] == "ready";
      var tool_number = data['result']['status']['toolchanger']['tool_number'];
      var tools       = data['result']['status']['toolchanger']['tool_numbers'];

      updatePositions(positions, gcode_pos);
      updateHoming(homed);
      updateQGL(qgl_done);
      updateMotor(checkActiveStepper(steppers));
      updateTools(tools, tool_number);
    }
  });
}

function updatePositions(positions, gcode_pos){
  if ($("#pos-x").text() != gcode_pos[0].toFixed(3)){
    $("#pos-x").text(gcode_pos[0].toFixed(3));
  }
  if ($("#pos-y").text() != gcode_pos[1].toFixed(3)){
    $("#pos-y").text(gcode_pos[1].toFixed(3));
  }
  if ($("#pos-z").text() != gcode_pos[2].toFixed(3)){
    $("#pos-z").text(gcode_pos[2].toFixed(3));
  }
}

function updateHoming(homed) {
    // Always update the data attribute first
    $("#home-all").data("homed", homed);

    // Force update the button states
    if (homed) {
        replaceClass("#home-all", "btn-danger", "btn-primary");
        replaceClass("#home-fine-x", "btn-dark", "btn-primary");
        replaceClass("#home-fine-y", "btn-dark", "btn-primary");
        replaceClass("#home-course-x", "btn-dark", "btn-primary");
        replaceClass("#home-course-y", "btn-dark", "btn-primary");
        replaceClass("#home-course-z", "btn-dark", "btn-primary");
    } else {
        replaceClass("#home-all", "btn-primary", "btn-danger");
        replaceClass("#home-fine-x", "btn-primary", "btn-dark");
        replaceClass("#home-fine-y", "btn-primary", "btn-dark");
        replaceClass("#home-course-x", "btn-primary", "btn-dark");
        replaceClass("#home-course-y", "btn-primary", "btn-dark");
        replaceClass("#home-course-z", "btn-primary", "btn-dark");
    }
}

function updateQGL(qgl_done) {
    // Always update the data attribute first
    $("#qgl").data("qgl", qgl_done);

    // Force update the button state
    if (qgl_done) {
        replaceClass("#qgl", "btn-danger", "btn-primary");
    } else {
        replaceClass("#qgl", "btn-primary", "btn-danger");
    }
}

function updateMotor(enabled) {
    // Always update the data attribute first
    $("#disable-motors").data("motoron", enabled);

    // Force update the button state
    if (enabled) {
        replaceClass("#disable-motors", "btn-danger", "btn-primary");
    } else {
        replaceClass("#disable-motors", "btn-primary", "btn-danger");
    }
}

function checkActiveStepper(array) {
  var result = false;

  $.each(array, function(key, value) {
      if (value === true) {
          result = true;
          return false;
      }
  });

  return result;
}

function replaceClass(id, old_class, new_class) {
  if ($(id).hasClass(old_class)) {
    $(id).removeClass(old_class);
    $(id).addClass(new_class);
  }
}

const bouncesComands = [
    'SAVE_GCODE_STATE NAME=bounce_move',
    'G91',
    '-bounce-',
    'RESTORE_GCODE_STATE NAME=bounce_move'
];
function ComandsUrl(axis, value) {
    let url = "";
    let bounce, move;
    
    if(value > 0){
        bounce = value + .5;
        move = -.5;
    } else {
        bounce = value - .5;
        move = .5;
    }
    
    $.each(bouncesComands, function(k, comand){
        if(comand == '-bounce-')
            url += 'G0 '+axis+bounce+ ' F500%0AG0 '+axis+move+' F500%0A';
        else
            url += comand +"%0A";
    });
    return url;
}

// Event handlers for printer modal
// Macro management
function saveMacro() {
    const name = $('#macro-name').val().trim();
    const command = $('#macro-command').val().trim();
    
    if (!name || !command) {
        console.log('Both name and command are required');
        return;
    }
    
    // Get existing macros or initialize empty array
    let macros = JSON.parse(localStorage.getItem('axiscope_macros') || '[]');
    
    // Add new macro
    macros.push({ name, command });
    
    // Save to localStorage
    localStorage.setItem('axiscope_macros', JSON.stringify(macros));
    
    // Clear inputs
    $('#macro-name').val('');
    $('#macro-command').val('');
    
    // Refresh macro list
    loadMacros();
}

function loadMacros() {
    const macros = JSON.parse(localStorage.getItem('axiscope_macros') || '[]');
    const $macroList = $('#macro-list');
    
    // Clear current list
    $macroList.empty();
    
    // Add each macro as a button
    macros.forEach((macro, index) => {
        const $item = $(`
            <div class="list-group-item d-flex justify-content-between align-items-center">
                <button 
                    type="button" 
                    class="btn btn-sm btn-secondary flex-grow-1 me-2"
                    onclick="executeMacro(${index})"
                >
                    ${macro.name}
                </button>
                <button 
                    type="button" 
                    class="btn btn-sm btn-danger"
                    onclick="deleteMacro(${index})"
                >
                    <i class="bi bi-trash"></i>
                </button>
            </div>
        `);
        $macroList.append($item);
    });
}

function executeMacro(index) {
    const macros = JSON.parse(localStorage.getItem('axiscope_macros') || '[]');
    const macro = macros[index];
    
    if (!macro) return;
    
    const url = printerUrl(printerIp, `/printer/gcode/script?script=${encodeURIComponent(macro.command)}`);
    
    $.get(url)
        .done(function() {
            console.log(`Executed macro: ${macro.name}`);
        })
        .fail(function(error) {
            console.error(`Failed to execute macro: ${macro.name}`, error);
        });
}

function deleteMacro(index) {
    let macros = JSON.parse(localStorage.getItem('axiscope_macros') || '[]');
    
    macros.splice(index, 1);
    localStorage.setItem('axiscope_macros', JSON.stringify(macros));
    
    loadMacros();
}

$(document).ready(function() {
    $("#ChangePrinter").click(function(){
        $('#printerModal').modal('show');
    });

    // Initialize printer modal
    $('#printerModal').modal('show');

    // Handle IP input validation
    $('#printerIp').on('input', function() {
        const ip = $(this).val();
        if (ip && !isValidIP(ip)) {
            $('#ipError').show();
            $('#saveIpBtn').prop('disabled', true);
        } else {
            $('#ipError').hide();
            $('#saveIpBtn').prop('disabled', false);
        }
    });

    // Handle save IP button click
    // Initialize macro list
    loadMacros();

    // Macro save button handler
    $('#save-macro').on('click', saveMacro);

    // Allow saving macro with Enter key in command input
    $('#macro-command').on('keypress', function(e) {
        if (e.which === 13) { // Enter key
            saveMacro();
        }
    });

    $('#saveIpBtn').on('click', function() {
        let ip = $('#printerIp').val();
        // Strip http:// or https:// when saving the IP
        ip = ip.replace(/^https?:\/\//, '');
        if (isValidIP(ip)) {
            console.log('Checking printer connection:', ip);
            
            // Disable the button and show loading state
            $(this).prop('disabled', true);
            $(this).html('<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Connecting...');
            
            // Make the connection request
            $.get(printerUrl(ip, "/server/info"), function(con_data) {
                console.log('Connection response:', con_data);
                
                if (con_data['result'] && con_data['result']['klippy_connected']) {
                    console.log('Successfully connected to printer');
                    // Show success state
                    $('#ipError').removeClass('text-danger').addClass('text-success').text('Connected successfully!').show();
                    
                    // Disable IP input and show disconnect button
                    $('#printerIp').prop('disabled', true);
                    $('#disconnectBtn').show();
                    
                    // Fetch camera list
                    $.get(printerUrl(ip, "/server/webcams/list"), function(cam_data) {
                        console.log('Camera data:', cam_data);
                        
                        if (cam_data['result'] && cam_data['result']['webcams']) {
                            const cams = cam_data['result']['webcams'];
                            
                            if (cams.length > 0) {
                                // Clear and populate camera list
                                const $cameraList = $('#cameraList');
                                $cameraList.empty();
                                
                                cams.forEach(function(cam) {
                                    const streamUrl = printerUrl(ip, cam.stream_url);
                                    const snapshotUrl = streamUrl.replace('?action=stream', '?action=snapshot');
                                    
                                    const cameraOption = `
                                        <div class="camera-option p-2" data-url="${streamUrl}">
                                            <div class="d-flex align-items-center">
                                                <div class="me-3">
                                                    <img src="${snapshotUrl}" 
                                                         class="camera-preview"
                                                         alt="${cam.name}"
                                                </div>
                                                <div>
                                                    <h6 class="mb-0">${cam.name}</h6>
                                                    <small class="text-muted">Click to select</small>
                                                </div>
                                            </div>
                                        </div>`;
                                    
                                    $cameraList.append(cameraOption);
                                });
                                
                                // Show camera selection
                                $('#camera-select').show();
                                // Update button for next step
                                $('#saveIpBtn').html('Select Camera').prop('disabled', false)
                                              .removeClass('btn-primary').addClass('btn-success');
                            } else {
                                $('#ipError').removeClass('text-success').addClass('text-danger')
                                           .text('No cameras found on this printer').show();
                            }
                        } else {
                            $('#ipError').removeClass('text-success').addClass('text-danger')
                                       .text('Error fetching camera list').show();
                        }
                    }).fail(function(error) {
                        console.error('Failed to fetch cameras:', error);
                        $('#ipError').removeClass('text-success').addClass('text-danger')
                                   .text('Could not fetch camera list from printer').show();
                    });
                } else {
                    console.log('Printer not ready');
                    $('#ipError').show().text('Printer is not ready. Please check if Klippy is connected.');
                    // Reset button
                    $('#saveIpBtn').prop('disabled', false).text('Retry Connection');
                }
            }).fail(function(error) {
                console.error('Connection failed:', error);
                $('#ipError').show().text('Could not connect to printer. Please check the IP address and ensure the printer is online.');
                // Reset button
                $('#saveIpBtn').prop('disabled', false).text('Retry Connection');
            });
        }
    });

    // Camera selection handler
    function connectCamera(selectedUrl) {
        // Stop any existing update interval
        if (updateInterval) {
            clearInterval(updateInterval);
            updateInterval = null;
        }

        const selectedIp = $('#printerIp').val();
        const webcamPath = selectedUrl.split(selectedIp)[1];  // Extract the path part
        
        // Update variables directly
        printerIp = selectedIp; // Update the global variable
        WebcamPath = webcamPath;
        
        // Update UI
        $("#zoom-image").attr("src", printerUrl(printerIp, WebcamPath));
        
        // Initialize button URLs and data attributes
        $("#home-all")
            .attr("data-url", printerUrl(printerIp, '/printer/gcode/script?script=G28'))
            .attr("data-homed", "false")
            .addClass("btn-danger").removeClass("btn-primary");
            
        $("#qgl")
            .attr("data-url", printerUrl(printerIp, '/printer/gcode/script?script=QUAD_GANTRY_LEVEL'))
            .attr("data-qgl", "false")
            .addClass("btn-danger").removeClass("btn-primary");
            
        $("#disable-motors")
            .attr("data-url", printerUrl(printerIp, '/printer/gcode/script?script=M84'))
            .attr("data-motoron", "false")
            .addClass("btn-danger").removeClass("btn-primary");
        
        // Show the camera container
        $('#camContainer').fadeIn();
        
        // Close the modal
        $('#printerModal').modal('hide');
        
        // Clear any existing position bars
        $('#BouncePositionBar, #BigPositionBar').empty();
        
        // Initialize position bars and other UI
        initializePositionBars();
        
        // Start the update cycle
        updatePage();
        getTools();
        updateInterval = setInterval(updatePage, 1000);
    }

    // Camera selection click handler
    $(document).on('click', '.camera-option', function() {
        const selectedUrl = $(this).data('url');
        if (selectedUrl) {
            console.log('Selected camera URL:', selectedUrl);
            // Update selection visual
            $('.camera-option').removeClass('selected');
            $(this).addClass('selected');
            // Update button state
            $('#saveIpBtn')
                .html('Connect to Camera')
                .prop('disabled', false)
                .removeClass('btn-success')
                .addClass('btn-primary')
                .off('click')
                .on('click', function() {
                    connectCamera(selectedUrl);
                });
        }
    });

    // Disconnect handler
    $('#disconnectBtn').on('click', function() {
        // Stop update interval
        if (updateInterval) {
            clearInterval(updateInterval);
            updateInterval = null;
        }

        // Reset global variables
        printerIp = '';
        WebcamPath = '/webcam?action=stream';
        path = '/webcam?action=stream';

        // Enable IP input
        $('#printerIp').prop('disabled', false);
        
        // Hide disconnect button
        $(this).hide();
        
        // Hide camera selection
        $('#camera-select').hide();
        
        // Hide camera container
        $('#camContainer').hide();
        
        // Reset button state
        $('#saveIpBtn').html('Save IP')
                       .prop('disabled', false)
                       .removeClass('btn-success btn-primary')
                       .addClass('btn-primary');
        
        // Clear error/success message
        $('#ipError').hide();
        
        // Clear camera list
        $('#cameraList').empty();

        // Clear position bars
        $('#BouncePositionBar, #BigPositionBar').empty();
    });

    // // Initialize UI components
    // $("#zoom-image").attr("src", printerUrl(printerIp, WebcamPath));
    // $("#home-all").attr("data-url", printerUrl(printerIp, '/printer/gcode/script?script=G28'));
    // $("#qgl").attr("data-url", printerUrl(printerIp, '/printer/gcode/script?script=QUAD_GANTRY_LEVEL'));
    // $("#disable-motors").attr("data-url", printerUrl(printerIp, '/printer/gcode/script?script=M84'));

    // dont think we need that just yet

    // Don't initialize anything until printer and camera are connected
});

// Initialize position bars
function initializePositionBars() {
    const bounceMove = (axis, value) => printerUrl(printerIp, '/printer/gcode/script?script=' + ComandsUrl(axis,value));
    // Clear both position bar containers
    $('#BouncePositionBar, #BigPositionBar').empty();
    const $container = $("#BouncePositionBar");
    const axes = ["X", "Y"];
    
    axes.forEach(axis => {
        const $row = $('<div class="row pb-1"></div>');
        const $toolbar = $('<div class="btn-toolbar justify-content-center" role="toolbar" aria-label="Movement Toolbar"></div>');
        const $btnGroup = $('<div class="btn-group btn-group-sm ps-5 pe-5" role="group"></div>');

        [-0.5, -0.1, -0.05, -0.01].forEach(value => {
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
            "data-url": printerUrl(printerIp, `/printer/gcode/script?script=G28${axis}`),
            id: `home-fine-${axis.toLowerCase()}`,
            text: axis
        }).appendTo($btnGroup);

        [0.01, 0.05, 0.1, 0.5].forEach(value => {
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

    const $containerBigPos = $("#BigPositionBar");
    const axesBigPos = ["X", "Y", "Z"];
    
    axesBigPos.forEach(axis => {
        const $row = $('<div class="row pb-1"></div>');
        const $toolbar = $('<div class="btn-toolbar justify-content-center" role="toolbar" aria-label="Movement Toolbar"></div>');
        const $btnGroup = $('<div class="btn-group btn-group-sm ps-5 pe-5" role="group"></div>');

        const values = axis != "Z" ? [-50, -10, -5, -1] : [-25, -10, -1, -.1];
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
            "data-url": printerUrl(printerIp, `/printer/gcode/script?script=G28${axis}`),
            id: `home-fine-${axis.toLowerCase()}`,
            text: axis
        }).appendTo($btnGroup);

        const reverseValues = axis != "Z" ? [50, 10, 5, 1].reverse() : [25, 10, 1, .1].reverse();
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

// Button click handlers
$(document).on("click", "button", function(e) {
    if ($(this).data("url")) {
        const url = $(this).data("url");
        $.get(url, function(data){
            // TODO check if it worked
        });
    } else if ($(this).data("axis")){
        const tool = $(this).data("tool");
        const axis = $(this).data("axis");
        const position = $("#pos-"+axis).text();
        
        $("input[name=T"+tool+"-"+axis+"-pos]").val(position);
        updateOffset(tool, axis);
    } else if ($(this).is("#capture-pos")) {
        const x_pos = parseFloat($("#pos-x").text()).toFixed(3);
        const y_pos = parseFloat($("#pos-y").text()).toFixed(3);
        const z_pos = parseFloat($("#pos-z").text()).toFixed(3);

        $("#captured-x").find(">:first-child").text(x_pos);
        $("#captured-y").find(">:first-child").text(y_pos);
        $("#captured-z").find(">:first-child").text(z_pos);
    } else if ($(this).is("#toolchange")) {
        const url = toolChangeURL($(this).data("tool"));
        $.get(url, function(data){});
    }
});

// Input change handlers
$(document).on("change", "input[type=number]", function(e) {
    const tool = $(this).data("tool");
    const axis = $(this).data("axis");
    updateOffset(tool, axis);
});