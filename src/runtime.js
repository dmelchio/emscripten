// Implementation details for the 'runtime environment' we generate in
// JavaScript. The Runtime object itself is used both during compilation,
// and is available at runtime (dynamic compilation). The RuntimeGenerator
// helps to create the Runtime object (written so that the Runtime object
// itself is as optimized as possible - no unneeded runtime checks).

RuntimeGenerator = {
  alloc: function(size, type, init) {
    var ret = type + 'TOP';
    if (ASSERTIONS) {
      ret += '; assert(' + size + ' > 0, "Trying to allocate 0")';
    }
    if (init) {
      ret += '; _memset(' + type + 'TOP, 0, ' + size + ')';
    }
    ret += '; ' + type + 'TOP += ' + size;
    if (QUANTUM_SIZE > 1) {
      ret += ';' + RuntimeGenerator.alignMemory(type + 'TOP', QUANTUM_SIZE);
    }
    return ret;
  },

  // An allocation that lives as long as the current function call
  stackAlloc: function(size) {
    if (USE_TYPED_ARRAYS === 2) 'STACKTOP += STACKTOP % ' + (QUANTUM_SIZE - (isNumber(size) ? Math.min(size, QUANTUM_SIZE) : QUANTUM_SIZE)) + ';';
    var ret = RuntimeGenerator.alloc(size, 'STACK', INIT_STACK);
    if (ASSERTIONS) {
      ret += '; assert(STACKTOP < STACK_ROOT + STACK_MAX, "Ran out of stack")';
    }
    return ret;
  },

  stackEnter: function(initial) {
    if (initial === 0 && SKIP_STACK_IN_SMALL) return '';
    if (USE_TYPED_ARRAYS === 2) initial = Runtime.forceAlign(initial);
    var ret = 'var __stackBase__  = STACKTOP; STACKTOP += ' + initial;
    if (ASSERTIONS) {
      ret += '; assert(STACKTOP < STACK_MAX)';
    }
    if (INIT_STACK) {
      ret += '; _memset(__stackBase__, 0, ' + initial + ')';
    }
    return ret;
  },

  stackExit: function(initial) {
    if (initial === 0 && SKIP_STACK_IN_SMALL) return '';
    var ret = '';
    if (SAFE_HEAP) {
      ret += 'for (var i = __stackBase__; i < STACKTOP; i++) SAFE_HEAP_CLEAR(i);';
    }
    return ret += 'STACKTOP = __stackBase__';
  },

  // An allocation that cannot be free'd
  staticAlloc: function(size) {
    return RuntimeGenerator.alloc(size, 'STATIC', INIT_HEAP);
  },

  alignMemory: function(target, quantum) {
    if (typeof quantum !== 'number') {
      quantum = '(quantum ? quantum : QUANTUM_SIZE)';
    }
    return target + ' = ' + Runtime.forceAlign(target, quantum) + ';';
  }
};

function unInline(name_, params) {
  var src = '(function ' + name_ + '(' + params + ') { var ret = ' + RuntimeGenerator[name_].apply(null, params) + '; return ret; })';
  //print('src: ' + src);
  return eval(src);
}

Runtime = {
  stackSave: function() {
    return STACKTOP;
  },
  stackRestore: function(stackTop) {
    STACKTOP = stackTop;
  },

  forceAlign: function(target, quantum) {
    quantum = quantum || QUANTUM_SIZE;
    if (isNumber(target) && isNumber(quantum)) {
      return Math.ceil(target/quantum)*quantum;
    } else {
      return 'Math.ceil((' + target + ')/' + quantum + ')*' + quantum;
    }
  },

  isNumberType: function(type) {
    return type in Runtime.INT_TYPES || type in Runtime.FLOAT_TYPES;
  },

  isPointerType: isPointerType,
  isStructType: isStructType,

  INT_TYPES: set('i1', 'i8', 'i16', 'i32', 'i64'),
  FLOAT_TYPES: set('float', 'double'),

  or64: function(x, y) {
    var l = (x | 0) | (y | 0);
    var h = (Math.round(x / 4294967296) | Math.round(y / 4294967296)) * 4294967296;
    return l + h;
  },
  and64: function(x, y) {
    var l = (x | 0) & (y | 0);
    var h = (Math.round(x / 4294967296) & Math.round(y / 4294967296)) * 4294967296;
    return l + h;
  },
  xor64: function(x, y) {
    var l = (x | 0) ^ (y | 0);
    var h = (Math.round(x / 4294967296) ^ Math.round(y / 4294967296)) * 4294967296;
    return l + h;
  },

  getNativeFieldSize: getNativeFieldSize,
  getNativeTypeSize: getNativeTypeSize,
  dedup: dedup,

  set: set,

  // Calculate aligned size, just like C structs should be. TODO: Consider
  // requesting that compilation be done with #pragma pack(push) /n #pragma pack(1),
  // which would remove much of the complexity here.
  calculateStructAlignment: function calculateStructAlignment(type) {
    type.flatSize = 0;
    type.alignSize = 0;
    var diffs = [];
    var prev = -1;
    type.flatIndexes = type.fields.map(function(field) {
      var size, alignSize;
      if (Runtime.isNumberType(field) || Runtime.isPointerType(field)) {
        size = Runtime.getNativeTypeSize(field); // pack char; char; in structs, also char[X]s.
        alignSize = size;
      } else if (Runtime.isStructType(field)) {
        size = Types.types[field].flatSize;
        alignSize = Types.types[field].alignSize;
      } else {
        dprint('Unclear type in struct: ' + field + ', in ' + type.name_ + ' :: ' + dump(Types.types[type.name_]));
        assert(0);
      }
      alignSize = type.packed ? 1 : Math.min(alignSize, QUANTUM_SIZE);
      type.alignSize = Math.max(type.alignSize, alignSize);
      var curr = Runtime.alignMemory(type.flatSize, alignSize); // if necessary, place this on aligned memory
      type.flatSize = curr + size;
      if (prev >= 0) {
        diffs.push(curr-prev);
      }
      prev = curr;
      return curr;
    });
    type.flatSize = Runtime.alignMemory(type.flatSize, type.alignSize);
    if (diffs.length == 0) {
      type.flatFactor = type.flatSize;
    } else if (Runtime.dedup(diffs).length == 1) {
      type.flatFactor = diffs[0];
    }
    type.needsFlattening = (type.flatFactor != 1);
    return type.flatIndexes;
  },

  // Given details about a structure, returns its alignment. For example,
  // generateStructInfo(
  //    [
  //      ['i32', 'field1'],
  //      ['i8', 'field2']
  //    ]
  // ) will return
  //    { field1: 0, field2: 4 } (depending on QUANTUM_SIZE)
  //
  // You can optionally provide a type name as a second parameter. In that
  // case, you do not need to provide the types. If the .ll contains debugging
  // symbols (i.e. it was compiled with the -g flag), you can leave the struct
  // parameter entirely empty, for example:
  //   generateStructInfo(null, '%struct.UserStructType');
  // If the compilation was done without symbols, you will still need to provide
  // the names, since they are not present in the .ll, for example:
  //   generateStructInfo(['field1', 'field2'], '%struct.UserStructType');
  //
  // Note that you will need the full %struct.* name here at compile time,
  // but not at runtime. The reason is that during compilation we cannot
  // simplify the type names yet. At runtime, you can provide either the short
  // or the full name.
  //
  // When providing a typeName, you can generate information for nested
  // structs, for example, struct = ['field1', { field2: ['sub1', 'sub2', 'sub3'] }, 'field3']
  // which repesents a structure whose 2nd field is another structure.
  generateStructInfo: function(struct, typeName, offset) {
    var type, alignment;
    if (typeName) {
      offset = offset || 0;
      type = (typeof Types === 'undefined' ? Runtime.typeInfo : Types.types)[typeName];
      if (!type) return null;
      if (!struct) struct = (typeof Types === 'undefined' ? Runtime : Types).structMetadata[typeName.replace(/.*\./, '')];
      if (!struct) return null;
      assert(type.fields.length === struct.length, 'Number of named fields must match the type for ' + typeName + '. Perhaps due to inheritance, which is not supported yet?');
      alignment = type.flatIndexes;
    } else {
      var type = { fields: struct.map(function(item) { return item[0] }) };
      alignment = Runtime.calculateStructAlignment(type);
    }
    var ret = {
      __size__: type.flatSize
    };
    if (typeName) {
      struct.forEach(function(item, i) {
        if (typeof item === 'string') {
          ret[item] = alignment[i] + offset;
        } else {
          // embedded struct
          var key;
          for (var k in item) key = k;
          ret[key] = Runtime.generateStructInfo(item[key], type.fields[i], alignment[i]);
        }
      });
    } else {
      struct.forEach(function(item, i) {
        ret[item[1]] = alignment[i];
      });
    }
    return ret;
  }
};

Runtime.stackAlloc = unInline('stackAlloc', ['size']);
Runtime.staticAlloc = unInline('staticAlloc', ['size']);
Runtime.alignMemory = unInline('alignMemory', ['size', 'quantum']);

function getRuntime() {
  var ret = 'var Runtime = {\n';
  for (i in Runtime) {
    var item = Runtime[i];
    ret += '  ' + i + ': ';
    if (typeof item === 'function') {
      ret += item.toString();
    } else {
      ret += JSON.stringify(item);
    }
    ret += ',\n';
  }
  return ret + '  __dummy__: 0\n}\n';
}

// Additional runtime elements, that need preprocessing

// Converts a value we have as signed, into an unsigned value. For
// example, -1 in int32 would be a very large number as unsigned.
function unSign(value, bits, ignore, sig) {
  if (value >= 0) {
#if CHECK_SIGNS
    if (!ignore) CorrectionsMonitor.note('UnSign', 1, sig);
#endif
    return value;
  }
#if CHECK_SIGNS
  if (!ignore) CorrectionsMonitor.note('UnSign', 0, sig);
#endif
  return bits <= 32 ? 2*Math.abs(1 << (bits-1)) + value // Need some trickery, since if bits == 32, we are right at the limit of the bits JS uses in bitshifts
                    : Math.pow(2, bits)         + value;
  // TODO: clean up previous line
}

// Converts a value we have as unsigned, into a signed value. For
// example, 200 in a uint8 would be a negative number.
function reSign(value, bits, ignore, sig) {
  if (value <= 0) {
#if CHECK_SIGNS
    if (!ignore) CorrectionsMonitor.note('ReSign', 1, sig);
#endif
    return value;
  }
  var half = bits <= 32 ? Math.abs(1 << (bits-1)) // abs is needed if bits == 32
                        : Math.pow(2, bits-1);
#if CHECK_SIGNS
  var noted = false;
#endif
  if (value >= half && (bits <= 32 || value > half)) { // for huge values, we can hit the precision limit and always get true here. so don't do that
#if CHECK_SIGNS
    if (!ignore) {
      CorrectionsMonitor.note('ReSign', 0, sig);
      noted = true;
    }
#endif
    value = -2*half + value; // Cannot bitshift half, as it may be at the limit of the bits JS uses in bitshifts
  }
#if CHECK_SIGNS
  // If this is a 32-bit value, then it should be corrected at this point. And,
  // without CHECK_SIGNS, we would just do the |0 shortcut, so check that that
  // would indeed give the exact same result.
  if (bits === 32 && (value|0) !== value && typeof value !== 'boolean') {
    if (!ignore) {
      CorrectionsMonitor.note('ReSign', 0, sig);
      noted = true;
    }
  }
  if (!noted) CorrectionsMonitor.note('ReSign', 1, sig);
#endif
  return value;
}

// Just a stub. We don't care about noting compile-time corrections. But they are called.
var CorrectionsMonitor = {
  note: function(){}
};

