namespace NoteApp.Helper
{
    public static class ColorHelper
    {
        private static readonly string[] Palette = new[]
        {
            "#e74c3c", "#3498db", "#2ecc71", "#f39c12",
            "#9b59b6", "#1abc9c", "#e67e22", "#e91e63",
            "#00bcd4", "#8bc34a", "#ff5722", "#607d8b"
        };

        /// <summary>
        /// Generate warna konsisten dari username.
        /// Username yang sama selalu dapat warna yang sama.
        /// </summary>
        public static string FromUsername(string? username)
        {
            if (string.IsNullOrEmpty(username)) return "#607d8b";

            // Hash deterministik dari string
            uint hash = 0;
            foreach (char c in username)
                hash = hash * 31 + c;

            return Palette[hash % (uint)Palette.Length];
        }
    }
}
