importScripts("jimp/browser/lib/jimp.min.js");

var fs = require("fs");

var hasTerminated;

var ImageMergeTask = function(){

  this.bufferImages = [];
  this.jimpImages = [];
  this.positions = [];
  this.totalHeight = null;
  this.totalCount = null;

  this.canvas = null;
  this.unfinishedCount = 0;
  this.path;

  hasTerminated = false;
}

ImageMergeTask.prototype.addImage = function(buffer, index, position){
  this.bufferImages[index] = buffer;
  this.positions[index] = position;

  var self = this;
  Jimp.read(buffer).then(function(image){
    self.jimpImages[index] = image;
    if(index == 0) {
      self.buildCanvas();
    } else {
      self.addImageOnCanvas(index);
    }
  }).catch(this.reject);
};

ImageMergeTask.prototype.setPath = function(path){
  this.path = path;
  if(this.total) {
    this.buildCanvas();
  }
}

ImageMergeTask.prototype.setCanvas = function(total, totalHeight){
  this.total = total;
  this.totalHeight = totalHeight;
  this.unfinishedCount = total;
  if(this.path) {
    this.buildCanvas();
  }
}

ImageMergeTask.prototype.buildCanvas = function(){
  if(!this.path || !this.jimpImages[0]) return;

  var pos = this.positions[0];
  this.canvas = this.jimpImages[0];
  if(this.total > 1) {
    this.canvas.contain(pos.width, this.totalHeight, Jimp.VERTICAL_ALIGN_TOP);
  }
  this.onCanvasPainted();
}

ImageMergeTask.prototype.onCanvasPainted = function(){
  for(var i = 1; i < this.total; i++) {
    this.addImageOnCanvas(i);
  }
  this.checkShouldEnd();
}

ImageMergeTask.prototype.addImageOnCanvas = function(i){
  var image = this.jimpImages[i];
  var pos = this.positions[i];
  if(image && this.canvas) {
    this.canvas.composite(image, 0, pos.offset);
    this.checkShouldEnd();
  }
}

ImageMergeTask.prototype.checkShouldEnd = function(){
  this.unfinishedCount--;
  if(this.unfinishedCount <= 0 || hasTerminated) {
    this.canvas.getBufferAsync(/\.png$/i.exec(this.path) ?Jimp.MIME_PNG : Jimp.MIME_JPEG)
      .then(this.resolve.bind(this))
      .catch(this.reject);
  }
}

ImageMergeTask.prototype.resolve = function(data){
  fs.writeFile(this.path, data, function(error){
    if(error) {
      this.reject(error);
    } else {
      postMessage({
        success: true
      });
    }
  });
}

ImageMergeTask.prototype.reject = function(e){
  postMessage({
    success: false,
    error: e & (e.stack || e)
  });
}

var imageMergeTask;

onmessage = function(e) {
  var data = e.data;
  if(data == "terminate") {
    hasTerminated = true;
    imageMergeTask = null;
  } else {
    if(!imageMergeTask) {
      imageMergeTask = new ImageMergeTask();
    }
    try {
      if(data.action === "addImage"){
        imageMergeTask.addImage(data.buffer, data.index, data.position);
        if(data.index == 0) {
          imageMergeTask.setCanvas(data.total, data.totalHeight);
        }
      } else if(data.action === "setPath"){
        imageMergeTask.setPath(data.path);
      } else if(data.action === "updateTotalHeight"){
        imageMergeTask.setCanvas(imageMergeTask.total, data.totalHeight);
      }
    } catch(e){
      imageMergeTask.reject(e);
      throw e;
    }
  }
}