$(document).ready(function() {

  $(document).on('click', 'button', function(e){
    url = $(this).data('url');

    $.get(url, function(data){
      // TODO check if it worked
    });
  });

});