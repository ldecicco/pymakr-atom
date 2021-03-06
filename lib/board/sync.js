'use babel';

var crypto = require('crypto');
import Shell from './shell.js'
import Config from '../config.js'
import Logger from '../helpers/logger.js'
import ApiWrapper from '../main/api-wrapper.js';
import ProjectStatus from './project-status.js';
import Utils from '../helpers/utils.js';
var fs = require('fs');
var path = require('path');

export default class Sync {



  constructor(pyboard,settings,terminal) {
    this.logger = new Logger('Sync')
    this.api = new ApiWrapper()
    this.settings = settings
    this.pyboard = pyboard
    this.terminal = terminal
    this.in_raw_mode = false
    this.total_file_size = 0
    this.total_number_of_files = 0
    this.number_of_changed_files = 0
    this.method_action = "Downloading"
    this.method_name = "Download"

    this.utils = new Utils(settings)
    this.config = Config.constants()
    this.allowed_file_types = this.settings.get_allowed_file_types()
    this.project_path = this.api.getProjectPath()
    this.isrunning = false
    this.fails = 0
  }

  isReady(){

    // check if there is a project open
    if(!this.project_path){
      return new Error("No project open")
    }
    // check if project exists
    if(!this.exists(this.settings.sync_folder)){
        return new Error("Unable to find folder '"+this.settings.sync_folder+"'. Please add the correct folder in your settings")
    }

    return true
  }

  exists(dir){
    return fs.existsSync(this.project_path + "/" + dir)
  }

  progress(text,count){
    if(this.isrunning){
      if(count){
        this.progress_file_count += 1
        text = "["+this.progress_file_count+"/"+this.number_of_changed_files+"] " + text
      }
      var _this = this
      setTimeout(function(){
        _this.terminal.writeln(text)
      },0)
    }
  }

  sync_done(err){
    this.logger.verbose("Sync done!")
    this.isrunning = false
    var mssg = this.method_name+" done"
    if(err){
      mssg = this.method_name+" failed."
      mssg += err.message && err.message != "" ? ": "+err.message : ""
      if(this.in_raw_mode){
        mssg += " Please reboot your device manually."
      }
    }else if(this.in_raw_mode && this.settings.reboot_after_upload){
      mssg += ", resetting board..."
    }

    this.terminal.writeln(mssg)

    if(this.pyboard.connected && !this.in_raw_mode){
      this.terminal.writePrompt()
    }

    this.oncomplete()
  }

  reset_values(oncomplete,method){

    // prepare variables
    if(method!='receive'){
      method = 'send'
      this.method_action = "Uploading"
      this.method_name = "Upload"
    }
    this.method = method
    this.oncomplete = oncomplete
    this.total_file_size = 0
    this.total_number_of_files = 0
    this.number_of_changed_files = 0
    this.progress_file_count = 0
    this.isrunning = true
    this.in_raw_mode = false

    this.project_path = this.api.getProjectPath()
    if(this.project_path){
      this.project_name = this.project_path.split('/').pop()

      var dir = this.settings.sync_folder.replace(/^\/|\/$/g, '') // remove first and last slash
      this.py_folder = this.project_path + "/"
      if(dir){
        this.py_folder += dir+"/"
      }

      var sync_folder = this.settings.sync_folder
      var folder_name = sync_folder == "" ? "main folder" : sync_folder
      this.folder_name = folder_name
    }
  }

  check_file_size(cb){
    var _this = this
    this.shell.getFreeMemory(function(size){
      if(_this.method == 'send' && size*1000 < _this.total_file_size){
        var mssg = "Not enough space left on device ("+size+"kb) to fit "+_this.total_number_of_files.toString()+" files of ("+parseInt(_this.total_file_size/1000).toString()+"kb)"
        cb(size,Error(mssg))
      }else{
        cb(size,null)
      }
    })
  }

  start(oncomplete){
    this.settings.refresh()
    this.__start_sync(oncomplete,'send')
  }

  start_receive(oncomplete){
    this.settings.refresh()
    this.__start_sync(oncomplete,'receive')
  }

  __start_sync(oncomplete,method){
    this.logger.info("Start sync method "+method)
    var _this = this
    this.fails = 0

    var cb = function(err){
      _this.sync_done(err)
    }

    try {
      this.reset_values(oncomplete,method)
    } catch(e){
      _this.logger.error(e)
      this.sync_done(e)
      return
    }

    // check if project is ready to sync
    var ready = this.isReady()
    if(ready instanceof Error){
      this.sync_done(ready)
      return
    }

    // make sure next messages will be written on a new line
    this.terminal.enter()

    this.terminal.write(this.method_action+" project ("+this.folder_name+")...\r\n")

    _this.__safe_boot(function(err){

      if(err){
        _this.logger.error("Safeboot failed")
        _this.logger.error(err)
      }else{
        _this.logger.info("Safeboot succesful")
      }

      _this.logger.silly("Start shell")
      _this.start_shell(function(err){
        _this.in_raw_mode = true

        _this.project_status = new ProjectStatus(_this.shell,_this.settings,_this.py_folder)
        _this.logger.silly("Entered raw mode")

        if(err || !_this.isrunning){
          _this.logger.error(err)
          _this.throwError(cb,err)
          _this.exit()

        }else{
          if(_this.method=='receive'){
            _this.__receive(cb,err)
          }else{
            _this.__send(cb,err)
          }
        }
      })
    })
  }

  __receive(cb,err){
    var _this = this

    _this.progress("Reading files from board")

    if(err){
      this.progress("Failed to read files from board, canceling file download")
      this.throwError(cb,err)
      return
    }

    this.shell.list_files(function(err,file_list){
      if(err){
        _this.progress("Failed to read files from board, canceling file download")
        _this.throwError(cb,err)
        return
      }
      _this.files = _this._getFilesRecursive("")
      var new_files = []
      var existing_files = []
      file_list = _this.utils.ignore_filter(file_list)
      for(var i=0;i<file_list.length;i++){
        var file = file_list[i]
        if(_this.files.indexOf(file) > -1){
          existing_files.push(file)
        }else{
          new_files.push(file)
        }
      }
      file_list = existing_files.concat(new_files)

      var mssg = "No files found on the board to download"

      if (new_files.length > 0){
        mssg = "Found "+new_files.length+" new "+_this.utils.plural("file",file_list.length)
      }
      if (existing_files.length > 0){
        if(new_files.length == 0){
          mssg = "Found "
        }else{
          mssg += " and "
        }
        mssg += existing_files.length+" existing "+_this.utils.plural("file",file_list.length)
      }
      // _this.progress(mssg)


      var time = Date.now()

      var checkTimeout = function(){
        if(Date.now() - time >  29000){
          _this.throwError(cb,new Error("Choice timeout (30 seconds) occurred."))
          return false
        }
        return true
      }

      var cancel = function(){
        if(checkTimeout()){
          _this.progress("Canceled")
          _this.exit(function(){
            _this.complete(cb)
          })
        }
      }

      var override = function(){
        if(checkTimeout()){
          _this.progress("Downloading "+file_list.length+" "+_this.utils.plural("file",file_list.length)+"...")
          _this.progress_file_count = 0
          _this.number_of_changed_files = file_list.length
          _this.receive_files(0,file_list,function(){
            _this.logger.info("All items received")
            _this.progress("All items overritten")
            _this.exit(function(){
              _this.complete(cb)
            })
          })
        }
      }

      var only_new = function(){
        if(checkTimeout()){
          _this.progress("Downloading "+new_files.length+" files...")
          _this.progress_file_count = 0
          _this.number_of_changed_files = new_files.length
          _this.receive_files(0,new_files,function(){
            _this.logger.info("All items received")
            _this.progress("All items overritten")
            _this.exit(function(){
              _this.complete(cb)
            })
          })
        }
      }
      var options = {
        "Cancel": cancel,
        "Yes": override,
      }
      if(new_files.length > 0){
        options["Only new files"] = only_new
      }
      setTimeout(function(){

        if(file_list.length == 0){
          _this.exit(function(){
            _this.complete(cb)
          })
          return true
        }

        mssg = mssg+". Do you want to download these files into your project ("+_this.project_name+" - "+_this.folder_name+"), overwriting existing files?"
        _this.progress(mssg)
        _this.progress("(Use the confirmation box at the top of the screen)")
        _this.api.confirm("Downloading files",mssg,options)
      },100)
    })
  }


  __safe_boot(cb){
    var _this = this
    _this.pyboard.stop_running_programs_double(function(){

      if(!_this.settings.safe_boot_on_upload){
        _this.progress("Not safe booting, disabled in settings")
        cb()
        return false
      }

        _this.logger.info("Safe booting...")
        _this.progress("Safe booting device... (see settings for more info)")
        _this.pyboard.safe_boot(cb,4000)
    },500)
  }

  receive_files(i,list,cb){
    var _this = this
    if(i >= list.length){
      cb()
      return
    }
    var filename = list[i]
    _this.progress("Reading "+filename,true)
    _this.shell.readFile(filename,function(err,content_buffer,content_st){

      if(err){
        _this.progress("Failed to download "+filename)
        _this.logger.error(err)
        _this.receive_files(i+1,list,cb)

      }else{
        var f = _this.py_folder + filename
        _this.ensureDirectoryExistence(f)
        try{
          var stream = fs.createWriteStream(f)
          stream.once('open', function(fd) {
            for(var j=0;j<content_buffer.length;j++){
                stream.write(content_buffer[j])
            }
            stream.end()
            _this.receive_files(i+1,list,cb)
          })
        }catch(e){
          _this.logger.error("Failed to open and write "+f)
          _this.logger.error(e)
          _this.progress("Failed to write to local file "+filename)
          _this.receive_files(i+1,list,cb)
        }
      }
    })
  }

  ensureDirectoryExistence(filePath) {
    var dirname = path.dirname(filePath)
    if (fs.existsSync(dirname)) {
      return true
    }
    this.ensureDirectoryExistence(dirname)
    fs.mkdirSync(dirname)
  }

  __send(cb,err){
    var _this = this
    this.progress("Reading file status")
    this.logger.info('Reading pymakr file')

    _this.project_status.read(function(err,content){
      if(!_this.isrunning){
        _this.throwError(cb,err)
        return
      }

      if(err){
        _this.progress("Failed to read project status, uploading all files")
      }

      _this.__write_changes(cb)
    })
  }

  __write_changes(cb){
    var _this = this

    var changes = _this.project_status.get_changes()

    var deletes = changes["delete"]
    var changed_files = changes["files"]
    var changed_folders = changes["folders"]
    var changed_files_folders = changed_folders.concat(changed_files)

    _this.number_of_changed_files = changed_files.length
    _this.max_failures = Math.min(Math.ceil(changed_files.length/2),5)

    if(deletes.length > 0){
      _this.progress("Deleting "+deletes.length.toString()+" files/folders")
    }

    if(deletes.length == 0 && changed_files.length == 0 && changed_folders.length == 0){
      _this.progress("No files to upload")
      _this.complete(cb)
      return
    }else{
      _this.logger.info('Removing files')
      _this.removeFilesRecursive(deletes,function(){

        if(deletes.length > 0){
          _this.logger.info("Updating project-status file")
        }
        _this.project_status.write(function(){

          _this.logger.info('Writing changed folders')
          _this.writeFilesRecursive(changed_files_folders,function(err){
            if(err || !_this.isrunning){
              _this.throwError(cb,err)
              return
            }
            setTimeout(function(){
              _this.logger.info('Writing project file')
              _this.project_status.write(function(err){
                if(err || !_this.isrunning){
                  _this.throwError(cb,err)
                  return
                }
                _this.logger.info('Exiting...')
                _this.complete(cb)
              })
            },300)
          })
        })
      })
    }
  }

  stop(){
    this.logger.info("stopped sync")
    this.isrunning = false
  }

  throwError(cb,err){
    var _this = this
    var mssg = err ? err : new Error("")

    this.logger.warning("Error thrown during sync procedure")

    if(!cb){
      this.sync_done(mssg)
    }else{
      cb(mssg)
    }

    _this.pyboard.stopWaitingForSilent()

    var _this = this
    this.exit(function(){
      _this.pyboard.enter_friendly_repl_non_blocking(function(){
        // do nothing, this might work or not based on what went wrong when synchronizing.
      })
    })
  }

  complete(cb){
    this.exit(function(){
      cb()
    })
  }

  removeFilesRecursive(files,cb,depth){
    var _this = this
    if(!depth){ depth = 0 }
    if(files.length == 0 || depth > 60){
      cb()
    }else{
      var file = files[0]
      var filename = file[0]
      var type = file[1]
      if(type == "d"){
        _this.progress("Removing dir "+filename)
        _this.shell.removeDir(filename,function(err){
          if(err){
            _this.progress("Failed to remove dir "+filename)
          }
          _this.project_status.update(filename)

          files.splice(0,1)
          _this.removeFilesRecursive(files,cb,depth+1)
        })
      }else{
        _this.progress("Removing file "+filename)
        _this.shell.removeFile(filename,function(err){
          if(err){
            _this.progress("Failed to remove file "+filename)
          }
          _this.project_status.update(filename)

          files.splice(0,1)
          _this.removeFilesRecursive(files,cb,depth+1)
        })
      }
    }
  }

  writeFilesRecursive(files,cb,depth){
    var _this = this
    if(!depth){ depth = 0 }

    var write_continue = function(files,cb,depth){
      if(files.length == 0 || depth > 60){
        cb()
      }else{
        var file = files[0]
        var filename = file[0]
        var type = file[1]
        if(type == "f"){
          try{
            var file_path = _this.py_folder + filename
            var contents = fs.readFileSync(file_path)

            _this.progress("Writing file "+filename,true)
            _this.shell.writeFile(filename,file_path,contents,function(err,retry){
              if(retry){
                _this.progress("Failed to write file, trying again...")
                // shell.writeFile automatically starts a re-try and executes the callback again
                // no other actions needed
              }else{
                if(err){
                  _this.fails += 1
                  if(_this.fails > _this.max_failures){
                    cb(err)
                    return
                  }else{
                    _this.progress(err.message)
                  }
                }else{
                  _this.project_status.update(filename)
                }
                files.splice(0,1)
                _this.writeFilesRecursive(files,cb,depth+1)
              }
            })
          }catch(e){
            _this.progress("Failed to write file")
            _this.logger.error(e)
            _this.writeFilesRecursive(files,cb,depth+1)
          }
        }else{
          _this.progress("Creating dir "+filename)
          _this.shell.createDir(filename,function(err){
            _this.project_status.update(filename)
            files.splice(0,1)
            _this.writeFilesRecursive(files,cb,depth+1)
          })
        }
      }
    }

    if(depth > 0 && depth%8 == 0){
      this.logger.info("Updating project-status file")
      this.project_status.write(function(err){
        write_continue(files,cb,depth)
      })
    }else{
      write_continue(files,cb,depth)
    }
  }

  start_shell(cb){
    this.shell = new Shell(this.pyboard,cb,this.method,this.settings)
  }

  _getFiles(dir){
    return fs.readdirSync(dir)
  }

  _getFilesRecursive(dir){
    var files = fs.readdirSync(this.py_folder+dir)
    var list = []
    for(var i=0;i<files.length;i++){
      var filename = dir + files[i]
      var file_path = this.py_folder + filename
      var stats = fs.lstatSync(file_path)
      if(!stats.isDirectory()){
        list.push(filename)
      }else{
        list = list.concat(this._getFilesRecursive(filename+"/"))
      }
    }
    return list
  }

  exit(cb){
    this.shell.exit(cb)
  }
}
