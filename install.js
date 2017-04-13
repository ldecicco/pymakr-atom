

// installing and re-compiling serialport
// not needed on windows, for which a pre-compiled version is included in the lib

if (process.platform != 'win32') {
  var exec = require('child_process').exec;
  exec('npm install serialport',
  function(error,stdout,stderr){
    if(error){
      console.log(error)
    }else{
      exec('electron-rebuild -f -w serialport -v 1.3.13',
      function(error,stout,stderr){
        if(error){
          console.log(error)
        }
      })
    }
  })
}