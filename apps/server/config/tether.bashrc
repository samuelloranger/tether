[ -f ~/.bashrc ] && source ~/.bashrc
_tether_pwd() {
  local tilde="~" p out="" seg i=0 n
  p="${PWD/#$HOME/$tilde}"
  local -a parts
  IFS=/ read -ra parts <<< "$p"
  n=${#parts[@]}
  for seg in "${parts[@]}"; do
    i=$((i+1))
    if [ $i -lt $n ] && [ -n "$seg" ]; then
      if [[ $seg == .* ]]; then out+="${seg:0:2}"; else out+="${seg:0:1}"; fi
    else
      out+="$seg"
    fi
    [ $i -lt $n ] && out+="/"
  done
  printf "%s" "$out"
}
_tether_branch() { local b; b=$(git branch --show-current 2>/dev/null); [ -n "$b" ] && printf " (%s)" "$b"; }
PS1='\[\e[36m\]$(_tether_pwd)\[\e[0m\]\[\e[33m\]$(_tether_branch)\[\e[0m\] \[\e[32m\]❯\[\e[0m\] '
