// Global variables and utility functions
let path = '/webcam?action=stream';

function printerUrl(ip, endpoint) {
    return `http://${ip}${endpoint}`;
}

function isValidIP(ip) {
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipRegex.test(ip)) return false;
    
    const parts = ip.split('.');
    return parts.every(part => {
        const num = parseInt(part, 10);
        return num >= 0 && num <= 255;
    });
}

function updatePage() {
  // @TODO need to remove this hardcoding

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
  if ($("#home-all").data("homed") != homed) {
    if (homed) {
      replaceClass("#home-all", "btn-danger", "btn-primary")
      replaceClass("#home-fine-x", "btn-dark", "btn-primary")
      replaceClass("#home-fine-y", "btn-dark", "btn-primary")
      replaceClass("#home-course-x", "btn-dark", "btn-primary")
      replaceClass("#home-course-y", "btn-dark", "btn-primary")
      replaceClass("#home-course-z", "btn-dark", "btn-primary")
    } else {
      replaceClass("#home-all", "btn-primary", "btn-danger")
      replaceClass("#home-fine-x", "btn-primary", "btn-dark")
      replaceClass("#home-fine-y", "btn-primary", "btn-dark")
      replaceClass("#home-course-x", "btn-primary", "btn-dark")
      replaceClass("#home-course-y", "btn-primary", "btn-dark")
      replaceClass("#home-course-z", "btn-primary", "btn-dark")
    }

    $("#home-all").data("homed", homed);
  }
}

function updateQGL(qgl_done) {
  if ($("#qgl").data("qgl") != qgl_done) {
    if (qgl_done) {
      replaceClass("#qgl", "btn-danger", "btn-primary")
    } else {
      replaceClass("#qgl", "btn-primary", "btn-danger")
    }

    $("#qgl").data("qgl", qgl_done);
  }
}

function updateMotor(enabled){
  if ($("#disable-motors").data("motoron") != enabled) {
    if (enabled) {
      replaceClass("#disable-motors", "btn-danger", "btn-primary")
    } else {
      replaceClass("#disable-motors", "btn-primary", "btn-danger")
    }

    $("#disable-motors").data("motoron", enabled);
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

const bounceMove = (axis, value) => `http://${printerIp}/printer/gcode/script?script=`+ComandsUrl(axis,value);
// Event handlers for printer modal
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
    $('#saveIpBtn').on('click', function() {
        const ip = $('#printerIp').val();
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
                                                         onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22160%22 height=%22120%22><rect width=%22160%22 height=%22120%22 fill=%22%23dee2e6%22/><text x=%2280%22 y=%2260%22 fill=%22%23666%22 text-anchor=%22middle%22>Loading...</text></svg>'">
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
    $(document).on('click', '.camera-option', function() {
        const selectedUrl = $(this).data('url');
        if (selectedUrl) {
            console.log('Selected camera URL:', selectedUrl);
            // Update selection visual
            $('.camera-option').removeClass('selected');
            $(this).addClass('selected');
            // Store the selected camera URL
            window.selectedCameraUrl = selectedUrl;
            // Update button state
            $('#saveIpBtn').html('Connect to Camera').prop('disabled', false)
                .removeClass('btn-success').addClass('btn-primary')
                .off('click')  // Remove previous click handlers
                .on('click', function() {
                    const selectedIp = $('#printerIp').val();
                    const webcamPath = selectedUrl.split(selectedIp)[1];  // Extract the path part
                    
                    // Update variables directly
                    window.printerIp = selectedIp;
                    window.WebcamPath = webcamPath;
                    
                    // Update UI
                    $("#zoom-image").attr("src", printerUrl(selectedIp, webcamPath));
                    $("#home-all").attr("data-url", printerUrl(selectedIp, '/printer/gcode/script?script=G28'));
                    $("#qgl").attr("data-url", printerUrl(selectedIp, '/printer/gcode/script?script=QUAD_GANTRY_LEVEL'));
                    $("#disable-motors").attr("data-url", printerUrl(selectedIp, '/printer/gcode/script?script=M84'));
                    
                    // Close the modal
                    $('#printerModal').modal('hide');
                    
                    // Start the update cycle
                    updatePage();
                    getTools();
                    setInterval(updatePage, 1000);
                });
        }
    });

    // Disconnect handler
    $('#disconnectBtn').on('click', function() {
        // Enable IP input
        $('#printerIp').prop('disabled', false);
        
        // Hide disconnect button
        $(this).hide();
        
        // Hide camera selection
        $('#camera-select').hide();
        
        // Reset button state
        $('#saveIpBtn').html('Save IP')
                       .prop('disabled', false)
                       .removeClass('btn-success btn-primary')
                       .addClass('btn-primary');
        
        // Clear error/success message
        $('#ipError').hide();
        
        // Clear camera list
        $('#cameraList').empty();
    });

    // Initialize UI components
    $("#zoom-image").attr("src", printerUrl(printerIp, WebcamPath));
    $("#home-all").attr("data-url", printerUrl(printerIp, '/printer/gcode/script?script=G28'));
    $("#qgl").attr("data-url", printerUrl(printerIp, '/printer/gcode/script?script=QUAD_GANTRY_LEVEL'));
    $("#disable-motors").attr("data-url", printerUrl(printerIp, '/printer/gcode/script?script=M84'));

    // Initialize position bars
    initializePositionBars();
    
    // Start page updates
    updatePage();
    getTools();
    setInterval(updatePage, 1000);
});

// Initialize position bars
function initializePositionBars() {

    // const bounceMove = (axis, value) => `http://${printerIp}/printer/gcode/script?script=`+ComandsUrl(axis,value);
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
            "data-url": printerUrl(printerIp, `/printer/gcode/script?script=G28${axis}`),
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