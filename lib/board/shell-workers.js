'use babel';
var fs = require('fs');
import Logger from '../helpers/logger.js'
import ApiWrapper from '../main/api-wrapper.js';
var binascii = require('binascii');

var EventEmitter = require('events');
const ee = new EventEmitter();

export default class ShellWorkers {


  constructor(shell,pyboard,settings){
    this.BIN_CHUNK_SIZE = 512
    this.shell = shell
    this.pyboard = pyboard
    this.settings = settings
    this.logger = new Logger('ShellWorkers')
  }

  write_file(value,callback){
    var _this = this
    var blocksize = _this.BIN_CHUNK_SIZE
    var content = value[0]
    var counter = value[1]

    if(counter*blocksize >= content.length){
      callback(null,content,true)
    }else{
      var start = counter*blocksize
      var end = Math.min((counter+1)*blocksize,content.length)
      var chunk = content.base64Slice(start,end)
      // c = binascii.b2a_base64(chunk)

      _this.pyboard.exec_raw("f.write(ubinascii.a2b_base64('"+chunk+"'))\r\n",function(err,data){
        if(data.indexOf("Traceback: ") > -1 || data.indexOf("Error: ") > -1){
          err_mssg = data.slice(data.indexOf("Error: ")+7,-3)
          err = new Error("Failed to write file: "+err_mssg)
        }
        if(err){
          _this.logger.error("Failed to write chunk:")
          _this.logger.error(err)
          callback(err,null)
          return
        }
        callback(null,[content,counter+1])
      })
    }
  }

  list_files(params,callback){
    var _this = this
    var [root,names,file_list] = params

    if(names.length == 0){
      callback(null,file_list,true)
    }else{
      var current_file = names[0]
      var current_file_root = root + "/" + current_file
      names = names.splice(1)
      var is_dir = current_file.indexOf('.') == -1
      if(is_dir){
        var c = "import ubinascii,sys\r\n"
        c += "list = ubinascii.hexlify(str(os.listdir('"+current_file_root + "')))\r\n"
        c += "sys.stdout.write(list)\r\n"
        _this.shell.eval(c,function(err,content){
            if(content){
              var data = binascii.unhexlify(content)
              data = data.slice(1,-2)
              try{
                var list = eval(data)
                for(var i=0;i<list.length;i++){
                  var item = list[i]
                  names.push(_this.get_file_with_path(current_file_root,item))
                }
                callback(null,[root,names,file_list])
              }catch(e){
                _this.logger.error("Evaluation of content went wrong")
                _this.logger.error(e)
                callback(e,[root,names,file_list])
              }
            }else{
              callback(new Error("Failed to write file"),[root,names,file_list])
            }
        })
      }else{
        var file_path = current_file_root
        if(file_path[0] == "/"){
          file_path = file_path.substring(1)
        }

        file_path = file_path.replace('/flash/','')
        file_path = file_path.replace('flash/','')

        file_list.push(file_path)
        callback(null,[root,names,file_list])
      }
    }
  }

  get_file_with_path(root,file){
    var root_cleaned = root.replace('/flash/','')
    root_cleaned = root_cleaned.replace('flash/','')

    if(root_cleaned != ""){
       root_cleaned += "/"
    }
    var file_path = root_cleaned + file
    if(file_path[0] == "/"){
      file_path = file_path.substring(1)
    }
    return file_path
  }
}
