using System.ComponentModel.DataAnnotations;

namespace NoteApp.Models
{
    public class BaseProperties
    {
        public string? Created_by { get; set; }
        public DateTime Created_on { get; set; } = DateTime.Now;
        public string? Modified_by { get; set; }
        public DateTime? Modified_on { get; set; }
        public string? Deleted_by { get; set; }
        public DateTime? Deleted_on { get; set; }
        public bool Is_delete { get; set; } = false;
    }
}
