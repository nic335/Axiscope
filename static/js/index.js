function updatePage() {
  $.get(printer_url + "/printer/objects/query?gcode_move&toolhead&motion_report&toolchanger&quad_gantry_level&stepper_enable", function(data){
    if (data['result']) {

      var positions   = data['result']['status']['gcode_move']['position'];
      var gcode_pos   = data['result']['status']['gcode_move']['gcode_position'];
      // var live_pos    = data['result']['status']['motion_report']['live_position'];
      var homed       = data['result']['status']['toolhead']['homed_axes'] == "xyz";
      var qgl_done    = data['result']['status']['quad_gantry_level']['applied'];
      var steppers    = data['result']['status']['stepper_enable']['steppers'];
      // var initialized = data['result']['status']['toolchanger']['status'] == "ready";
      var tool_number = data['result']['status']['toolchanger']['tool_number'];
      var tools       = data['result']['status']['toolchanger']['tool_numbers'];

      // console.log(live_pos);

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


$(document).ready(function() {
  $(document).on("click", ".getGcodes", function(e){
    navigator.clipboard.writeText($(this).find("input[axis=x]").val() +"\n"+ $(this).find("input[axis=y]").val());
  });

  updatePage();
  getTools();

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