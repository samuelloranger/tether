[ -f ~/.zshrc ] && source ~/.zshrc
_tether_osc7() { printf "\e]7;file://%s%s\a" "$(hostname)" "$PWD"; }
precmd_functions+=(_tether_osc7)
