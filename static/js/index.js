function updatePage() {
  $.get(printer_url + "/printer/objects/query?gcode_move&toolhead&toolchanger&quad_gantry_level&stepper_enable", function(data){
    if (data['result']) {

      var positions   = data['result']['status']['gcode_move']['position'];
      var gcode_pos   = data['result']['status']['gcode_move']['gcode_position'];
      var homed       = data['result']['status']['toolhead']['homed_axes'] == "xyz";
      var qgl_done    = data['result']['status']['quad_gantry_level']['applied'];
      var steppers    = data['result']['status']['stepper_enable']['steppers'];
      var initialized = data['result']['status']['toolchanger']['status'] == "ready";

      updatePositions(positions, gcode_pos);
      updateHoming(homed);
      updateQGL(qgl_done);
      updateTools(initialized);
      updateMotor(checkActiveStepper(steppers));
      updateTools();

      console.log(homed);

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


function updateTools(){

}

function getPrinterConfig() {
  $.get("/xhr/get_printer_config", function(data){
    $.get("/xhr/all_tools", function(jinja){
      $('#tools-list').replaceWith(jinja);
    });
  });

}

function replaceClass(id, old_class, new_class) {
  if ($(id).hasClass(old_class)) {
    $(id).removeClass(old_class);
    $(id).addClass(new_class);
  }
}


$(document).ready(function() {
  updatePage();
  getPrinterConfig();

  setInterval(function(){
    updatePage();

  }, 1000);


});