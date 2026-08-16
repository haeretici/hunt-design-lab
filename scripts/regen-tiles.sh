for d in assets/sprites/*/tiles/original; do
  [ -d "$d" ] || continue
  npm run process -- "$d" --force --opaque-alpha
done
for d in assets/sprites/*/overlays/original; do
  [ -d "$d" ] || continue
  npm run process -- "$d" --force
done

