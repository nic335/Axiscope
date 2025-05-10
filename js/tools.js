
const zeroListItem = ({tool_number, disabled, tc_disabled}) => `
<li class="list-group-item bg-body-tertiary p-2">
  <div class="container">
    <div class="row">
      <div class="col-2">
        <button 
          type="button"
          class="btn btn-secondary btn-sm w-100 h-100 ${tc_disabled}"
          id="toolchange"
          name="T${tool_number}"
          data-tool="${tool_number}"
        >
          <h1>T${tool_number}</h1>
        </button>
      </div>

      <div class="col-6" >
        <button 
          type="button" 
          class="btn btn-sm btn-secondary fs-6 border text-center h-100 w-100 ps-5 pe-5 ${disabled}" 
          style="padding-bottom:5px; padding-top:5px;" 
          id="capture-pos"
          >
            CAPTURE <br/> CURRENT <br/> POSITION
          </button>
      </div>

      <div class="col-4 border rounded bg-dark">
        <div class="row">
          <span class="fs-6 lh-sm pt-1 pb-1"><small>Captured Position</small></span>
          <div class="row justify-content-center">
            <div class="col-1 ms-4">
              <span class="fs-5 lh-sm"><small>X:</small></span>
            </div>
            <div class="col-6">
              <span class="fs-5 lh-sm" id="captured-x" data-axis="x"><small></small></span>
            </div>
          </div>
          <div class="row justify-content-center">
            <div class="col-1 ms-4">
              <span class="fs-5 lh-sm"><small>Y:</small></span>
            </div>
            <div class="col-6">
              <span class="fs-5 lh-sm" id="captured-y" data-axis="y"><small></small></span>
            </div>
          </div>
          <div class="row justify-content-center">
            <div class="col-1 ms-4">
              <span class="fs-5 lh-sm"><small>Z:</small></span>
            </div>
            <div class="col-6">
              <span class="fs-5 lh-sm" id="captured-z" data-axis="z"><small></small></span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</li>
`;

const nonZeroListItem = ({tool_number, cx_offset, cy_offset, disabled, tc_disabled}) => `
<li class="list-group-item bg-body-tertiary p-2">
  <div class="container">
    <div class="row">
      <div class="col-2">
        <button 
          type="button"
          class="btn btn-secondary btn-sm w-100 h-100 ${tc_disabled}"
          id="toolchange"
          name="T${tool_number}"
          data-tool="${tool_number}"
        >
          <h1>T${tool_number}</h1>
        </button>
      </div>

      <div class="col-6">
        <div class="row pb-4">
            <div class="input-group ps-1 pe-1">
              <button 
                class="btn btn-secondary ${disabled}" 
                type="button" 
                id="T${tool_number}-fetch-x" 
                data-axis="x" 
                data-tool="${tool_number}" 
              >X</button>
              <input 
                type="number" 
                name="T${tool_number}-x-pos"
                class="form-control" 
                placeholder="0.0" 
                aria-label="Grab Current X Position" 
                aria-describedby="x-axis" 
                data-axis="x" 
                data-tool="${tool_number}" 
                ${disabled}
              >
            </div>
        </div>

        <div class="row">
            <div class="input-group ps-1 pe-1">
              <button 
                class="btn btn-secondary ${disabled}" 
                type="button" 
                id="T${tool_number}-fetch-y" 
                data-axis="y" 
                data-tool="${tool_number}" 
              >Y</button>
              <input 
                type="number" 
                name="T${tool_number}-y-pos"
                class="form-control" 
                placeholder="0.0" 
                aria-label="Grab Current Y Position" 
                aria-describedby="y-axis" 
                data-axis="y" 
                data-tool="${tool_number}" 
                ${disabled}
              >
            </div>
        </div>
      </div>

      <div class="col-4 border rounded bg-dark">
        <div class="row">
          <div class="col-6 pt-1 pb-1">
            <div class="row pb-1">
              <span class="fs-6 lh-sm text-secondary"><small>Current X</small></span>
              <span class="fs-5 lh-sm text-secondary" id="T${tool_number}-x-offset"><small>${cx_offset}</small></span>
            </div>
            <div class="row">
              <span class="fs-6 lh-sm text-secondary"><small>Current Y</small></span>
              <span class="fs-5 lh-sm text-secondary" id="T${tool_number}-y-offset"><small>${cy_offset}</small></span>
            </div>
          </div>

          <div class="col-6 pt-2 pb-2 getGcodes" toolId="${tool_number}">
            <div class="row pb-1">
              <span class="fs-6 lh-sm"><small>New X</small></span>
              <span class="fs-5 lh-sm" id="T${tool_number}-x-new"><small>0.0</small></span>
              <button class="btn btn-link btn-sm p-0 text-decoration-none" id="T${tool_number}-x-gcode" axis="x" style="font-size: 0.8em;">Click to copy</button>
            </div>
            <div class="row">
              <span class="fs-6 lh-sm"><small>New Y</small></span>
              <span class="fs-5 lh-sm" id="T${tool_number}-y-new"><small>0.0</small></span>
              <button class="btn btn-link btn-sm p-0 text-decoration-none" id="T${tool_number}-y-gcode" axis="y" style="font-size: 0.8em;">Click to copy</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</li>
`;


function toolChangeURL(tool) {
  var x_pos = $("#captured-x").find(">:first-child").text();
  var y_pos = $("#captured-y").find(">:first-child").text();
  var z_pos = $("#captured-z").find(">:first-child").text();
  var url = printerUrl(printerIp, "/printer/gcode/script?script=T" + tool)

  if (x_pos != "") {
    url = url + "%0ASAVE_GCODE_STATE NAME=RESTORE_POS"
    url = url + "%0AG90";
    url = url + "%0AG0 Z" + z_pos + " F3000";
    url = url + "%0AG0 X" + x_pos + " Y" + y_pos + " F12000";
    url = url + "%0ARESTORE_GCODE_STATE NAME=RESTORE_POS"
  }

  return url;
}


function getTools() {
  var url = printerUrl(printerIp, "/printer/objects/query?toolchanger")
  var tool_names;
  var tool_numbers;
  var active_tool;

  $.get(url, function(data){
    tool_names   = data['result']['status']['toolchanger']['tool_names'];
    tool_numbers = data['result']['status']['toolchanger']['tool_numbers'];
    active_tool  = data['result']['status']['toolchanger']['tool_number'];

    url = printerUrl(printerIp, "/printer/objects/query?")

    $.each(tool_numbers, function(i) {
      url = url + tool_names[i] + "&";
    });

    url = url.substring(0, url.length-1);

    $.get(url, function(data){
      $("#tool-list").html('');
      $.each(tool_numbers, function(i) {
        var tool_number = data['result']['status'][tool_names[i]]['tool_number'];
        var cx_offset   = data['result']['status'][tool_names[i]]['gcode_x_offset'].toFixed(3);
        var cy_offset   = data['result']['status'][tool_names[i]]['gcode_y_offset'].toFixed(3);
        var disabled    = "";
        var tc_disabled = "disabled";

        if (tool_number != active_tool) {
          disabled    = "disabled";
          tc_disabled = "";
        }
        
        if (tool_number === 0) {
          $("#tool-list").append(zeroListItem({tool_number: tool_number, disabled: disabled, tc_disabled: tc_disabled}));
        } else {
          $("#tool-list").append(nonZeroListItem({tool_number: tool_number, cx_offset: cx_offset, cy_offset: cy_offset, disabled: disabled, tc_disabled: tc_disabled}));
        }
      });
      
      // Set up copy handlers for all tools
      tool_numbers.forEach(tool => {
        ['x', 'y'].forEach(axis => {
          $(`#T${tool}-${axis}-gcode`).off('click').on('click', function() {
            const $this = $(this);
            const originalText = $this.text();
            const newOffset = $(`#T${tool}-${axis}-new`).find('>:first-child').text();
            const gcodeCommand = `gcode_${axis}_offset: ${newOffset}`;
            
            // Create temporary textarea
            const textarea = document.createElement('textarea');
            textarea.value = gcodeCommand;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            
            try {
              textarea.select();
              document.execCommand('copy');
              $this.text('Copied!');
              setTimeout(() => $this.text(originalText), 1000);
            } catch (err) {
              console.error('Failed to copy:', err);
            } finally {
              document.body.removeChild(textarea);
            }
          });
        });
      });
    });

    updateTools(tool_numbers, active_tool);
  });
}


function updateTools(tool_numbers, tn){
  const $captureBtn = $("#capture-pos");
  if(tn !== 0) {
    $captureBtn.addClass("disabled").prop("disabled", true);
  } else {
    $captureBtn.removeClass("disabled").prop("disabled", false);
  }

  $.each(tool_numbers, function(tool_no) {
    updateOffset(tool_no, "x");
    updateOffset(tool_no, "y");
    if (tn == tool_no) {
      if (!$("button[name=T"+tool_no+"]").hasClass("disabled")) {
        $("button[name=T"+tool_no+"]").addClass("disabled");
        $("#T"+tool_no+"-fetch-x").removeClass("disabled");
        $("#T"+tool_no+"-fetch-y").removeClass("disabled");
        $("input[name=T"+tool_no+"-x-pos]").removeAttr("disabled");
        $("input[name=T"+tool_no+"-y-pos]").removeAttr("disabled");
      }
    } else if ($("button[name=T"+tool_no+"]").hasClass("disabled")) {
      $("button[name=T"+tool_no+"]").removeClass("disabled");
      $("#T"+tool_no+"-fetch-x").addClass("disabled");
      $("#T"+tool_no+"-fetch-y").addClass("disabled");
      $("input[name=T"+tool_no+"-x-pos]").attr("disabled", "disabled");
      $("input[name=T"+tool_no+"-y-pos]").attr("disabled", "disabled");
    }
  });
}


function updateOffset(tool, axis) {
  var captured_pos = $("#captured-"+axis).text();

  if (captured_pos != "") {
    captured_pos   = parseFloat(captured_pos);
    var position   = parseFloat($("input[name=T"+tool+"-"+axis+"-pos]").val());
    var old_offset = parseFloat($("#T"+tool+"-"+axis+"-offset").text());

    if (isNaN(position)) {
      position = 0.0;
    }

    var new_offset = (captured_pos-old_offset) - position;
    

    
    // Modify new_offset for display
    if (new_offset < 0) {
      new_offset = Math.abs(new_offset);
    } else {
      new_offset = -new_offset;
    }

    var offset_delta;
    if(new_offset == old_offset){
      offset_delta = 0;
    }else{
      // For delta: if new is more negative than old, it's negative delta
      offset_delta = Math.abs(new_offset) > Math.abs(old_offset) ? 
          -(Math.abs(new_offset) - Math.abs(old_offset)) : 
          Math.abs(old_offset) - Math.abs(new_offset);
    }

    const newOffsetText = new_offset.toFixed(3);
    
    // Update display
    // id="T${tool_number}-x-offset"
    $(`#T${tool}-${axis}-new`).attr('delta', offset_delta);
    $(`#T${tool}-${axis}-new`).find('>:first-child').text(newOffsetText);
  }
}