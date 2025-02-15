function updatePage() {
  $.get(printer_url + "/printer/objects/query?gcode_move&toolhead&toolchanger&quad_gantry_level&stepper_enable", function(data){
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
      replaceClass("#home-x", "btn-dark", "btn-primary")
      replaceClass("#home-y", "btn-dark", "btn-primary")
    } else {
      replaceClass("#home-all", "btn-primary", "btn-danger")
      replaceClass("#home-x", "btn-primary", "btn-dark")
      replaceClass("#home-y", "btn-primary", "btn-dark")
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


function updateTools(tool_numbers, tn){
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


function getPrinterConfig() {
  $.get("/xhr/get_printer_config", function(data){
    $.get("/xhr/all_tools", function(jinja){
      $('#tools-list').replaceWith(jinja);
    });

    var tools   = data['tool_numbers'];
    var tool_no = data['tool'];

    updateTools(tools, tool_no);
  });
}


function replaceClass(id, old_class, new_class) {
  if ($(id).hasClass(old_class)) {
    $(id).removeClass(old_class);
    $(id).addClass(new_class);
  }
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

    var new_offset = captured_pos - position + old_offset;
    $("#T"+tool+"-"+axis+"-new").find(">:first-child").text(new_offset.toFixed(3));
  }
}


function toolChangeURL(tool) {
  var x_pos = $("#captured-x").find(">:first-child").text();
  var y_pos = $("#captured-y").find(">:first-child").text();
  var z_pos = $("#captured-z").find(">:first-child").text();
  var url   = printer_url + "/printer/gcode/script?script=T" + tool;

  if (x_pos != "") {
    url = url + "%0AG0 Z" + z_pos + " F3000";
    url = url + "%0AG0 X" + x_pos + " Y" + y_pos + " F12000";
  }

  return url;
}


$(document).ready(function() {
  updatePage();
  getPrinterConfig();

  setInterval(function(){
    updatePage();
  }, 1000);


  $(document).on("click", "button", function(e){
    if ($(this).data("url")) {
      url = $(this).data("url");

      $.get(url, function(data){
        // TODO check if it worked
      });

    } else if ($(this).data("axis")){
      var tool     = $(this).data("tool");
      var axis     = $(this).data("axis");
      var position = $("#pos-"+axis).text();
      
      $("input[name=T"+tool+"-"+axis+"-pos]").val(position);

      updateOffset(tool, axis);

    } else if ($(this).is("#capture-pos")) {
      var x_pos = parseFloat($("#pos-x").text()).toFixed(3);
      var y_pos = parseFloat($("#pos-y").text()).toFixed(3);
      var z_pos = parseFloat($("#pos-z").text()).toFixed(3);

      $("#captured-x").find(">:first-child").text(x_pos);
      $("#captured-y").find(">:first-child").text(y_pos);
      $("#captured-z").find(">:first-child").text(z_pos);

    } else if ($(this).is("#toolchange")) {
      var url  = toolChangeURL($(this).data("tool"));

      $.get(url, function(data){
      });
    }
  });

  $(document).on("change", "input[type=number]", function(e){
    var tool = $(this).data("tool");
    var axis = $(this).data("axis");
    updateOffset(tool, axis);
  });

});