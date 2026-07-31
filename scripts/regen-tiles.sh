for d in assets/sprites/*/tiles/original; do                                                              
  [ -d "$d" ] || continue                                                                                 
  npm run process -- "$d" --force --opaque-alpha                                                          
done 
